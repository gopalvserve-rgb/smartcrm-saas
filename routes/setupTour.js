/**
 * routes/setupTour.js — SETUP_TOUR_v1 (2026-07-11)
 *
 * First-run "Setup Guide" for a newly-joined tenant. ADMIN ONLY.
 *
 * Shows a checklist of the 4 things a new workspace must configure, and stays
 * visible on the dashboard until every stage is complete (or the admin hides it).
 *
 * Completion is DATA-DRIVEN — each stage is marked done by inspecting the real
 * CRM state, so it auto-completes as the admin actually does the work. A manual
 * override (mark done / reopen) is persisted per-tenant in config SETUP_TOUR_STATE.
 *
 *   api_setup_status(token)              -> { admin, show, tasks[], done_count, total, all_done, dismissed }
 *   api_setup_setState(token, {key,done}) -> manual override (done:1 | 0 | 'auto' to clear)
 *   api_setup_dismiss(token, {dismissed}) -> hide / re-show the guide
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const STATE_KEY = 'SETUP_TOUR_STATE';

const TASKS = [
  { key: 'company',  title: 'Company Setup',
    desc: 'Add your company name and logo — they appear on the login screen, sidebar, invoices and emails.',
    hash: '#/admin', hint: 'Settings → Company' },
  { key: 'statuses', title: 'Create Lead Statuses',
    desc: 'Build the pipeline stages your team actually uses (New, Contacted, Qualified, Won, Lost…).',
    hash: '#/admin', hint: 'Settings → Lead Statuses' },
  { key: 'wa',       title: 'Connect WhatsApp',
    desc: 'Link your WhatsApp Business number to chat, send templates and run bots straight from the CRM.',
    hash: '#/whatsbot/connect', hint: 'WhatsApp → Connect Account' },
  { key: 'fb',       title: 'Connect Facebook Lead Ads',
    desc: 'Sync your Facebook / Instagram lead forms so every enquiry lands in the CRM instantly.',
    hash: '#/admin', hint: 'Settings → Facebook Lead Forms' }
];

async function _readState() {
  try { const raw = await db.getConfig(STATE_KEY, ''); return raw ? JSON.parse(raw) : {}; }
  catch (_) { return {}; }
}
async function _writeState(st) {
  // NOTE: db.setConfig directly — api_admin_setConfig has a CONFIG_KEYS allowlist
  // that would silently drop this key.
  await db.setConfig(STATE_KEY, JSON.stringify(st || {}));
}

/** Inspect the real CRM state to decide which stages are already complete. */
async function _detect() {
  const out = {};

  try {
    const name = String(await db.getConfig('COMPANY_NAME', '') || '').trim();
    const logo = String(await db.getConfig('COMPANY_LOGO_URL', '') || '').trim();
    out.company = {
      done: !!name && !!logo,
      detail: !name ? 'Company name not set' : (!logo ? 'Name set — logo still missing' : 'Name + logo set')
    };
  } catch (_) { out.company = { done: false, detail: '' }; }

  try {
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM statuses`);
    const n = Number(r.rows[0] && r.rows[0].n) || 0;
    // >= 2 means a real pipeline was built (a single auto-created "New" doesn't count).
    out.statuses = { done: n >= 2, detail: n ? (n + ' status' + (n > 1 ? 'es' : '') + ' created') : 'No statuses yet' };
  } catch (_) { out.statuses = { done: false, detail: '' }; }

  try {
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM wa_phones WHERE is_active = 1`);
    const n = Number(r.rows[0] && r.rows[0].n) || 0;
    out.wa = { done: n > 0, detail: n ? (n + ' number connected') : 'Not connected' };
  } catch (_) { out.wa = { done: false, detail: 'Not connected' }; }

  try {
    const raw = await db.getConfig('META_PAGES_LIST', '');
    let pages = []; try { pages = raw ? JSON.parse(raw) : []; } catch (_) { pages = []; }
    const mon = pages.filter(p => p && p.is_monitored).length;
    out.fb = {
      done: mon > 0,
      detail: mon ? (mon + ' page' + (mon > 1 ? 's' : '') + ' monitored')
                  : (pages.length ? 'Connected — no page monitored yet' : 'Not connected')
    };
  } catch (_) { out.fb = { done: false, detail: 'Not connected' }; }

  return out;
}

async function api_setup_status(token) {
  const me = await authUser(token);
  // Non-admins never see the guide.
  if (me.role !== 'admin') return { admin: false, show: false, tasks: [], done_count: 0, total: TASKS.length, all_done: true, dismissed: true };

  const st  = await _readState();
  const det = await _detect();
  const overrides = st.overrides || {};

  const tasks = TASKS.map(t => {
    const d = det[t.key] || { done: false, detail: '' };
    const forced = overrides[t.key];
    const done = forced === 1 ? true : (forced === 0 ? false : d.done);
    return {
      key: t.key, title: t.title, desc: t.desc, hash: t.hash, hint: t.hint,
      done, detail: d.detail,
      manual: forced === 1 && !d.done      // marked done by hand, not detected
    };
  });

  const doneCount = tasks.filter(t => t.done).length;
  const allDone   = doneCount === tasks.length;
  const dismissed = Number(st.dismissed) === 1;

  // 10-day onboarding countdown, anchored on the first time the admin saw the guide.
  if (!st.started_at) { st.started_at = new Date().toISOString(); await _writeState(st); }
  const daysUsed = Math.floor((Date.now() - new Date(st.started_at).getTime()) / 86400000);
  const daysLeft = Math.max(0, 10 - daysUsed);

  return {
    admin: true,
    tasks,
    done_count: doneCount,
    total: tasks.length,
    all_done: allDone,
    dismissed,
    show: !allDone && !dismissed,
    just_completed: allDone && !st.completed_at,
    welcome_seen: Number(st.welcome_seen) === 1,
    days_left: daysLeft
  };
}

/** Day-0 welcome modal shown once. */
async function api_setup_seenWelcome(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const st = await _readState();
  st.welcome_seen = 1;
  await _writeState(st);
  return { ok: true };
}

async function api_setup_setState(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  const key = String(p.key || '');
  if (!TASKS.some(t => t.key === key)) throw new Error('Unknown setup task: ' + key);
  const st = await _readState();
  st.overrides = st.overrides || {};
  if (p.done === 'auto' || p.done === null || p.done === undefined) delete st.overrides[key];
  else st.overrides[key] = Number(p.done) === 1 ? 1 : 0;
  await _writeState(st);
  return { ok: true };
}

async function api_setup_dismiss(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  const st = await _readState();
  st.dismissed = Number(p.dismissed) === 0 ? 0 : 1;
  if (st.dismissed === 1 && !st.completed_at) st.completed_at = new Date().toISOString();
  if (st.dismissed === 0) st.completed_at = null;
  await _writeState(st);
  return { ok: true, dismissed: st.dismissed };
}

module.exports = { api_setup_status, api_setup_setState, api_setup_dismiss, api_setup_seenWelcome };
