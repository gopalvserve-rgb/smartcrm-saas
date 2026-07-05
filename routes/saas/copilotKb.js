/**
 * routes/saas/copilotKb.js  —  COPILOT_KB_v1 (2026-07-04)
 *
 * Super-admin-managed knowledge base for the in-app "Ask CRM" Copilot.
 * Adds an EDITABLE source (FAQs, tutorials, video links, URLs) on top of the
 * built-in help guide (public/saas/help/index.html via utils/setupGuide.js),
 * manageable from the admin panel WITHOUT code changes.
 *
 * Storage: control DB table `copilot_kb` (platform-wide). crmCopilot.js merges
 * lookupActive() with the static guide hits when answering.
 */
'use strict';

const control = require('../../control/db');
const { requireSuperAdmin, requireFullAdmin } = require('./superAdminAuth');

const KINDS = ['faq', 'tutorial', 'guide', 'video', 'link'];

let _ensured = false;
async function _ensure() {
  if (_ensured) return;
  await control.query(`CREATE TABLE IF NOT EXISTS copilot_kb (
    id          SERIAL PRIMARY KEY,
    kind        VARCHAR(20)  NOT NULL DEFAULT 'faq',
    title       TEXT         NOT NULL,
    keywords    TEXT         NOT NULL DEFAULT '',
    body        TEXT         NOT NULL DEFAULT '',
    url         TEXT         NOT NULL DEFAULT '',
    is_active   SMALLINT     NOT NULL DEFAULT 1,
    sort_order  INTEGER      NOT NULL DEFAULT 100,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`);
  _ensured = true;
}

let _cache = null, _cacheAt = 0;
const _TTL_MS = 60 * 1000;
function _bust() { _cache = null; _cacheAt = 0; }

async function _activeEntries() {
  if (_cache && (Date.now() - _cacheAt) < _TTL_MS) return _cache;
  try {
    await _ensure();
    const r = await control.query(
      `SELECT id, kind, title, keywords, body, url FROM copilot_kb
        WHERE is_active = 1 ORDER BY sort_order ASC, id DESC LIMIT 1000`
    );
    _cache = r.rows.map(x => ({
      id: 'kb_' + x.id, kind: x.kind || 'faq',
      title: String(x.title || ''), keywords: String(x.keywords || '').toLowerCase(),
      body: String(x.body || ''), url: String(x.url || '')
    }));
    _cacheAt = Date.now();
  } catch (e) { console.warn('[copilotKb] _activeEntries failed:', e.message); _cache = _cache || []; }
  return _cache;
}

function _score(entry, tokens) {
  const t = entry.title.toLowerCase(), k = entry.keywords, b = entry.body.toLowerCase();
  let s = 0;
  for (const tok of tokens) { if (t.includes(tok)) s += 8; if (k.includes(tok)) s += 5; if (b.includes(tok)) s += 1; }
  return s;
}

async function lookupActive(query, limit) {
  const lim = Math.max(1, Math.min(5, Number(limit) || 3));
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/[^a-z0-9]+/i).filter(t => t && t.length > 1);
  if (!tokens.length) return [];
  const entries = await _activeEntries();
  return entries
    .map(e => ({ e, s: _score(e, tokens) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, lim)
    .map(({ e }) => {
      let body = e.body;
      if (e.url) body += ' (Link: ' + e.url + ')';
      return { id: e.id, title: e.title + (e.kind ? ' [' + e.kind + ']' : ''), url: e.url || '', body: body.slice(0, 700) };
    });
}

async function api_saas_copilotKb_listAdmin(token) {
  await requireSuperAdmin(token);
  await _ensure();
  const r = await control.query(`SELECT * FROM copilot_kb ORDER BY sort_order ASC, id DESC LIMIT 2000`);
  return r.rows;
}

async function api_saas_copilotKb_trainedSummary(token) {
  await requireSuperAdmin(token);
  await _ensure();
  let builtin = [];
  try {
    const setupGuide = require('../../utils/setupGuide');
    builtin = (setupGuide.getIndex() || []).map(s => ({ id: s.id, title: s.title, url: s.url }));
  } catch (e) { console.warn('[copilotKb] builtin index failed:', e.message); }
  let kbCount = 0, kbActive = 0;
  try {
    const c = await control.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(is_active),0)::int AS a FROM copilot_kb`);
    kbCount = Number(c.rows[0].n) || 0; kbActive = Number(c.rows[0].a) || 0;
  } catch (_) {}
  // COPILOT_KB_BUILTIN_OFF_v1 — expose the built-in enable flag so the SPA
  // shows a toggle and users can turn the /saas/help/ feed off entirely.
  let builtinEnabled = true;
  try {
    const v = await control.getSetting('COPILOT_KB_BUILTIN_ENABLED');
    builtinEnabled = String(v == null ? '1' : v) === '1';
  } catch (_) {}
  return {
    builtin_count: builtin.length, builtin, kb_count: kbCount, kb_active: kbActive,
    builtin_enabled: builtinEnabled,
    help_url: 'https://crm.smartcrmsolution.com/saas/help/',
    tutorial_url: 'https://crm.smartcrmsolution.com/tutorial/'
  };
}

/** COPILOT_KB_BUILTIN_OFF_v1 — turn the built-in Setup Guide feed on/off.
 *  When off, crmCopilot.lookup_setup_guide skips setupGuide.lookup and
 *  answers only from the curated copilot_kb table. Persist in control settings. */
async function api_saas_copilotKb_setBuiltinEnabled(token, payload) {
  await requireFullAdmin(token);
  const p = payload || {};
  const enabled = (Number(p.enabled) === 1 || p.enabled === true || p.enabled === '1') ? '1' : '0';
  await control.setSetting('COPILOT_KB_BUILTIN_ENABLED', enabled);
  return { ok: true, enabled: enabled === '1' };
}

async function api_saas_copilotKb_save(token, payload) {
  await requireFullAdmin(token);
  await _ensure();
  const p = payload || {};
  const title = String(p.title || '').trim();
  if (!title) throw new Error('Title is required');
  const kind = KINDS.includes(String(p.kind)) ? String(p.kind) : 'faq';
  const data = {
    kind, title: title.slice(0, 300),
    keywords: String(p.keywords || '').trim().slice(0, 1000),
    body: String(p.body || '').trim().slice(0, 8000),
    url: String(p.url || '').trim().slice(0, 800),
    is_active: Number(p.is_active) === 0 ? 0 : 1,
    sort_order: Number.isFinite(Number(p.sort_order)) ? Number(p.sort_order) : 100
  };
  let id;
  if (p.id) { await control.update('copilot_kb', Number(p.id), data); id = Number(p.id); }
  else { id = await control.insert('copilot_kb', data); }
  _bust();
  return { ok: true, id };
}

async function api_saas_copilotKb_delete(token, id) {
  await requireFullAdmin(token);
  await _ensure();
  await control.query(`DELETE FROM copilot_kb WHERE id = $1`, [Number(id)]);
  _bust();
  return { ok: true };
}

async function api_saas_copilotKb_toggle(token, id, is_active) {
  await requireFullAdmin(token);
  await _ensure();
  await control.query(`UPDATE copilot_kb SET is_active = $1, updated_at = NOW() WHERE id = $2`,
    [Number(is_active) === 1 ? 1 : 0, Number(id)]);
  _bust();
  return { ok: true };
}

module.exports = {
  api_saas_copilotKb_listAdmin, api_saas_copilotKb_trainedSummary,
  api_saas_copilotKb_save, api_saas_copilotKb_delete, api_saas_copilotKb_toggle,
  api_saas_copilotKb_setBuiltinEnabled,
  lookupActive
};
