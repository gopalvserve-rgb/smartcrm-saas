/* PHONE_FORMAT_v1 — 2026-07-14
 * Per-source phone-format configuration + backfill APIs.
 *
 * Storage: reuses lead_source_mapping.phone_format (JSONB, added lazily).
 * Rule shape: see utils/phoneFormat.js
 *
 * Endpoints:
 *   api_phoneFormat_get(source)            → { rule }
 *   api_phoneFormat_save(source, rule)     → { ok }
 *   api_phoneFormat_test(source, samples)  → { rows[] } sample transformation
 *   api_phoneFormat_backfill_preview(rule, opts) → { total, changed, invalid, dupes, preview[] }
 *   api_phoneFormat_backfill_apply(rule, opts)   → { updated, dupes }
 *   api_phoneFormat_listSources()          → distinct sources with a rule
 */
'use strict';

const db  = require('../db/pg');
const pfx = require('../utils/phoneFormat');

async function _authAdmin(token) {
  const auth = require('../utils/auth');
  const u = await auth.authUser(token);
  if (!u) throw new Error('unauthorized');
  if (u.role !== 'admin' && u.role !== 'manager') throw new Error('admin/manager only');
  return u;
}

async function _ensureCol() {
  try {
    await db.query(`ALTER TABLE lead_source_mapping ADD COLUMN IF NOT EXISTS phone_format JSONB NOT NULL DEFAULT '{}'::jsonb`);
  } catch (_) {}
  try {
    await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_raw TEXT`);
  } catch (_) {}
}

async function api_phoneFormat_get(token, source) {
  await _authAdmin(token);
  await _ensureCol();
  const src = String(source || '').toLowerCase().trim();
  if (!src) throw new Error('source required');
  const r = await db.query(`SELECT phone_format FROM lead_source_mapping WHERE source=$1`, [src]);
  const rule = (r.rows[0] && r.rows[0].phone_format) || {};
  return {
    rule: {
      source_format:  rule.source_format  || 'auto',
      store_format:   rule.store_format   || 'raw',
      default_cc:     rule.default_cc     || 'IN',
      apply_to_wa:    !!rule.apply_to_wa,
      reject_invalid: !!rule.reject_invalid,
      dedupe_on_phone:rule.dedupe_on_phone !== false /* default true */
    }
  };
}

async function api_phoneFormat_save(token, source, rule) {
  await _authAdmin(token);
  await _ensureCol();
  const src = String(source || '').toLowerCase().trim();
  if (!src) throw new Error('source required');
  const clean = {
    source_format:   String((rule && rule.source_format)  || 'auto'),
    store_format:    String((rule && rule.store_format)   || 'raw'),
    default_cc:      String((rule && rule.default_cc)     || 'IN').toUpperCase(),
    apply_to_wa:     !!(rule && rule.apply_to_wa),
    reject_invalid:  !!(rule && rule.reject_invalid),
    dedupe_on_phone: (rule && rule.dedupe_on_phone !== false)
  };
  const has = await db.query(`SELECT 1 FROM lead_source_mapping WHERE source=$1`, [src]);
  if (has.rows.length) {
    await db.query(`UPDATE lead_source_mapping SET phone_format=$2, updated_at=NOW() WHERE source=$1`, [src, JSON.stringify(clean)]);
  } else {
    await db.query(
      `INSERT INTO lead_source_mapping (source, mapping, phone_format) VALUES ($1, '{}'::jsonb, $2::jsonb)`,
      [src, JSON.stringify(clean)]
    );
  }
  return { ok: true, rule: clean };
}

async function api_phoneFormat_test(token, source, samples) {
  await _authAdmin(token);
  await _ensureCol();
  const src = String(source || '').toLowerCase().trim();
  const r = await db.query(`SELECT phone_format, last_payload FROM lead_source_mapping WHERE source=$1`, [src]);
  const rule = (r.rows[0] && r.rows[0].phone_format) || {};
  /* Build sample list: caller-supplied first, else pull from last_payload OR webhook_log */
  let list = Array.isArray(samples) ? samples.filter(Boolean).map(String) : [];
  if (!list.length) {
    try {
      const wl = await db.query(
        `SELECT payload FROM webhook_log WHERE source=$1 ORDER BY id DESC LIMIT 5`, [src]
      );
      wl.rows.forEach(row => {
        const p = row.payload || {};
        /* look for a phone-ish field */
        const fields = ['phone', 'mobile', 'SENDER_MOBILE', 'MOBILE', 'contact_number', 'whatsapp'];
        for (const f of fields) {
          if (p[f]) { list.push(String(p[f])); break; }
        }
      });
    } catch (_) {}
  }
  if (!list.length) list = ['918825858113', '+919876543210', '9876543210', '09876543210', '123'];
  const rows = list.map(raw => {
    const n = pfx.normalizePhone(raw, rule);
    return { raw, normalized: n.value, valid: n.valid, changed: n.changed };
  });
  return { rows, rule };
}

async function api_phoneFormat_backfill_preview(token, rule, opts) {
  await _authAdmin(token);
  await _ensureCol();
  opts = opts || {};
  const src = opts.source ? String(opts.source).toLowerCase().trim() : null;
  const limit = Math.min(Number(opts.limit || 500), 5000);
  /* Pull a batch of leads to preview against.
   * If source filter provided, restrict to that source (case-insensitive). */
  const args = [];
  const w = [];
  if (src) { args.push(src); w.push(`LOWER(COALESCE(source,'')) = $${args.length}`); }
  w.push(`phone IS NOT NULL AND phone <> ''`);
  const sql = `SELECT id, name, phone FROM leads WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`;
  const r = await db.query(sql, args);
  return pfx.backfillPreview(r.rows, rule);
}

async function api_phoneFormat_backfill_apply(token, rule, opts) {
  await _authAdmin(token);
  await _ensureCol();
  opts = opts || {};
  const src = opts.source ? String(opts.source).toLowerCase().trim() : null;
  const limit = Math.min(Number(opts.limit || 10000), 50000);
  const args = [];
  const w = [];
  if (src) { args.push(src); w.push(`LOWER(COALESCE(source,'')) = $${args.length}`); }
  w.push(`phone IS NOT NULL AND phone <> ''`);
  const sql = `SELECT id, phone FROM leads WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`;
  const r = await db.query(sql, args);
  let updated = 0, invalid = 0, unchanged = 0;
  const seen = {};
  const dupes = [];
  for (const row of r.rows) {
    const p = pfx.normalizePhone(row.phone, rule);
    if (!p.value) { invalid++; continue; }
    if (p.value === row.phone) { unchanged++; continue; }
    if (seen[p.value]) { dupes.push({ id: row.id, other_id: seen[p.value], normalized: p.value }); continue; }
    seen[p.value] = row.id;
    try {
      await db.query(
        `UPDATE leads SET phone_raw = COALESCE(phone_raw, phone), phone = $2 WHERE id = $1`,
        [row.id, p.value]
      );
      updated++;
    } catch (_) { invalid++; }
  }
  return { updated, invalid, unchanged, dupes, scanned: r.rows.length };
}

async function api_phoneFormat_listSources(token) {
  await _authAdmin(token);
  await _ensureCol();
  const r = await db.query(
    `SELECT DISTINCT LOWER(source) AS source FROM leads WHERE source IS NOT NULL AND source <> '' ORDER BY 1`
  );
  const configured = await db.query(`SELECT source FROM lead_source_mapping WHERE phone_format IS NOT NULL AND phone_format <> '{}'::jsonb`);
  const cfgSet = new Set(configured.rows.map(x => String(x.source).toLowerCase()));
  return {
    sources: r.rows.map(x => ({ source: x.source, configured: cfgSet.has(String(x.source).toLowerCase()) }))
  };
}

module.exports = {
  api_phoneFormat_get,
  api_phoneFormat_save,
  api_phoneFormat_test,
  api_phoneFormat_backfill_preview,
  api_phoneFormat_backfill_apply,
  api_phoneFormat_listSources
};
