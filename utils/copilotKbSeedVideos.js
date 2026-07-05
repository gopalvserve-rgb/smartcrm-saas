/**
 * utils/copilotKbSeedVideos.js  —  COPILOT_KB_VIDEOS_SEED_v1 (2026-07-05)
 *
 * One-shot boot seeder: inserts the 12 official Smart CRM video tutorials
 * (from https://smartcrmsolution.com/home/smart-crm-plan/knowledge-base.php)
 * into the control-plane `copilot_kb` table so the in-app "Ask CRM" Copilot
 * can hand out the right video link when users ask "how do I connect
 * WhatsApp", "how do I import leads", etc.
 *
 * Idempotent: guarded by control setting `COPILOT_KB_VIDEOS_SEEDED_v1`.
 * Re-runs safely a second time by upserting via title match.
 */
'use strict';

const control = require('../control/db');

const KB_MASTER = {
  kind: 'link',
  title: 'Smart CRM Video Tutorial Library',
  keywords: 'video tutorial library help learn how to knowledge base training guide videos walkthrough demo',
  body: 'The full Smart CRM video tutorial library — 12 short videos covering user setup, products & statuses, bulk lead upload, auto-assign, website & lead-source integrations, WhatsApp connect, templates & bulk send, auto-nurture, AI WhatsApp bot, and mobile call recording. Every video is short and practical.',
  url: 'https://smartcrmsolution.com/home/smart-crm-plan/knowledge-base.php',
  sort_order: 1
};

const KB_VIDEOS = [
  {
    kind: 'video',
    title: 'Video 01 — User Creation',
    keywords: 'user creation add user new user create user team account role permission access invite staff sales agent user setup employee login',
    body: 'How to create team accounts inside Smart CRM. Add a new user, assign a role (Admin / Manager / Team Leader / Sales), and configure permissions so each teammate can only see and do what they should. Under 3 minutes.',
    url: 'https://drive.google.com/file/d/1NMMwtu6eM4xzDE5Gsk-Ya-BGtpgPsTGp/view',
    sort_order: 10
  },
  {
    kind: 'video',
    title: 'Video 02 — Products, Statuses & Custom Fields',
    keywords: 'product status custom field pipeline stage tailor configuration setup catalog stages status list lead status new hot cold custom column',
    body: 'Tailor Smart CRM to your business — add your product/service list, define the lead statuses that match your sales pipeline (e.g. New → Contacted → Qualified → Won), and add the custom fields you actually need (city, budget, source-specific data, etc).',
    url: 'https://drive.google.com/file/d/1uzkz7Qz9F6nuBL_eVWavKsEqorcHVxHY/view',
    sort_order: 20
  },
  {
    kind: 'video',
    title: 'Video 03 — Bulk Lead Upload',
    keywords: 'bulk upload import leads csv excel spreadsheet mass import upload sheet leads file bulk add many leads at once',
    body: 'How to import thousands of leads at once from a CSV or Excel file. Field-mapping walkthrough, data validation, duplicate handling. Finish uploading in minutes.',
    url: 'https://drive.google.com/file/d/1iS9wgmx1shIL4dNiuVI3uezE2vTYnyMj/view',
    sort_order: 30
  },
  {
    kind: 'video',
    title: 'Video 04 — Lead Auto Assign (Basics)',
    keywords: 'auto assign automatic assignment round robin distribute leads routing rule assign to user team fair distribution auto assignment',
    body: 'Set up basic auto-assign rules so every incoming lead is automatically routed to a team member — no manual assignment, no lead sitting in a queue.',
    url: 'https://drive.google.com/file/d/10nC6gSnlrl3jo4tmUab3CLAwlYZ1nJlT/view',
    sort_order: 40
  },
  {
    kind: 'video',
    title: 'Video 05 — Lead Auto Assign — Advanced',
    keywords: 'auto assign advanced weighted source based team specific routing rule advanced assignment leads source lead source route',
    body: 'Advanced auto-assign — weighted distribution (agent A gets 60%, agent B 40%), source-based routing (Facebook leads → team X, website leads → team Y), team-specific rules, and conditional overrides.',
    url: 'https://drive.google.com/file/d/1MOHxdtRxr52NxOnsbPtP8MfVM0_EiVc5/view',
    sort_order: 50
  },
  {
    kind: 'video',
    title: 'Video 06 — Connect Website API, JustDial, IndiaMart & Other Sources',
    keywords: 'website api justdial indiamart integration connect lead source webhook lead capture form website leads integration sources',
    body: 'Pull leads automatically from your own website, JustDial, IndiaMart and other channels. Webhook / API setup so every inquiry lands in Smart CRM in real time — no copy-paste and no missed leads.',
    url: 'https://drive.google.com/file/d/1iSRXa9JEzJ3GyzFNkdtZ6CQovHNaH9G2/view',
    sort_order: 60
  },
  {
    kind: 'video',
    title: 'Video 07 — Facebook Lead Ads Connect',
    keywords: 'facebook lead ads connect integration meta ads fb lead form facebook form leadgen sync facebook leads facebook business',
    body: 'Sync Facebook Lead Ads directly into Smart CRM. Every form submission lands in your pipeline in real time — with the ad name, campaign, and form fields all attached to the lead.',
    url: 'https://drive.google.com/file/d/1lKWn5lNRpKHF9fiT34i6pj02DMXXTua2/view',
    sort_order: 70
  },
  {
    kind: 'video',
    title: 'Video 08 — Connect Your WhatsApp',
    keywords: 'whatsapp connect setup wa business api integration link whatsapp connect account whatsapp number embedded signup meta',
    body: 'How to connect your WhatsApp Business number to Smart CRM using the embedded signup flow. This is the foundation for every WhatsApp workflow — templates, bulk send, auto-reply and the AI bot.',
    url: 'https://drive.google.com/file/d/1JAJY-aJtsT1tzxjxXq_KdbFajfrHrGE5/view',
    sort_order: 80
  },
  {
    kind: 'video',
    title: 'Video 09 — WhatsApp Templates & Bulk Send',
    keywords: 'whatsapp template bulk send campaign broadcast marketing message template approval whatsapp campaign send many contacts',
    body: 'Build Meta-approved WhatsApp templates and send bulk WhatsApp campaigns the right way — without getting your number flagged. Covers template categories, variables, media, and best-practice send rates.',
    url: 'https://drive.google.com/file/d/1Kjme07ODhpVwapk5-9CbMcAuYFYTkFic/view',
    sort_order: 90
  },
  {
    kind: 'video',
    title: 'Video 10 — WhatsApp Auto Send & Lead Nurturing',
    keywords: 'auto send whatsapp nurturing automation status trigger auto message drip campaign follow up automated whatsapp nurture leads',
    body: 'Set up automated WhatsApp messages that fire on lead status changes (e.g. new lead → welcome, qualified → catalog, no-response → follow-up). Nurture prospects on autopilot.',
    url: 'https://drive.google.com/file/d/16qQrh6DroUhLxzCWJZx26FrKAOmWVfYu/view',
    sort_order: 100
  },
  {
    kind: 'video',
    title: 'Video 11 — Build an AI WhatsApp Bot',
    keywords: 'ai bot whatsapp chatbot ai whatsapp automation ai reply intelligent bot 24/7 qualifier gemini gpt auto reply bot ai bot setup',
    body: 'Configure an intelligent WhatsApp bot that qualifies inquiries, replies to FAQs, captures details and routes leads to the right salesperson — 24/7, straight inside Smart CRM.',
    url: 'https://drive.google.com/file/d/18xdFCcop46NRPd0DFQ492rAadhJ2APmi/view',
    sort_order: 110
  },
  {
    kind: 'video',
    title: 'Video 12 — Set Up Call Recording on Mobile',
    keywords: 'call recording mobile app android call record recording setup mobile app permissions accessibility record call auto record calls',
    body: 'Step-by-step walkthrough to enable and configure call recording on the Smart CRM mobile app. Grant the right permissions on Android, verify recordings sync to the lead, and troubleshoot missing recordings.',
    url: 'https://drive.google.com/file/d/120XjVXGvxhtuipFRfWA8Kg9Wh2imags1/view',
    sort_order: 120
  }
];

async function _upsertEntry(e) {
  // Look up by title (unique enough within our KB, and we control it).
  const ex = await control.query(`SELECT id FROM copilot_kb WHERE title = $1 LIMIT 1`, [e.title]);
  if (ex.rows.length) {
    await control.query(
      `UPDATE copilot_kb SET kind=$1, keywords=$2, body=$3, url=$4, sort_order=$5, is_active=1, updated_at=NOW() WHERE id=$6`,
      [e.kind, e.keywords, e.body, e.url, e.sort_order, ex.rows[0].id]
    );
    return { id: ex.rows[0].id, action: 'updated' };
  }
  const r = await control.query(
    `INSERT INTO copilot_kb (kind, title, keywords, body, url, sort_order, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,NOW(),NOW()) RETURNING id`,
    [e.kind, e.title, e.keywords, e.body, e.url, e.sort_order]
  );
  return { id: r.rows[0].id, action: 'inserted' };
}

async function seed(opts) {
  const force = !!(opts && opts.force);
  try {
    const applied = await control.getSetting('COPILOT_KB_VIDEOS_SEEDED_v1');
    if (!force && applied === '1') {
      return { skipped: 'already-seeded' };
    }
    // Make sure the table exists (in case copilotKb.js has never been loaded).
    await control.query(`CREATE TABLE IF NOT EXISTS copilot_kb (
      id SERIAL PRIMARY KEY,
      kind VARCHAR(20) NOT NULL DEFAULT 'faq',
      title TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      is_active SMALLINT NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const out = { inserted: 0, updated: 0, errors: [] };
    for (const e of [KB_MASTER, ...KB_VIDEOS]) {
      try {
        const r = await _upsertEntry(e);
        out[r.action]++;
      } catch (err) { out.errors.push({ title: e.title, err: err.message }); }
    }
    await control.setSetting('COPILOT_KB_VIDEOS_SEEDED_v1', '1');
    console.log('[COPILOT_KB_VIDEOS_SEED_v1] ' + out.inserted + ' inserted, ' + out.updated + ' updated');
    return out;
  } catch (e) {
    console.warn('[COPILOT_KB_VIDEOS_SEED_v1] failed:', e.message);
    return { error: e.message };
  }
}

module.exports = { seed, KB_MASTER, KB_VIDEOS };
