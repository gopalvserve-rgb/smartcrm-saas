/* PHONE_91_PREFIX_v1 — 2026-07-14
 * Tenant-wide toggle + one-shot backfill for existing leads.
 * Config key: PHONE_91_PREFIX_ENABLED ('0' | '1')
 */
'use strict';
const db  = require('../db/pg');
const { normalize91 } = require('../utils/phone91');

async function _admin(token) {
  const { authUser } = require('../utils/auth');
  const u = await authUser(token);
  if (!u || (u.role !== 'admin' && u.role !== 'manager')) throw new Error('admin/manager only');
  return u;
}

async function api_phone91_get(token) {
  await _admin(token);
  const v = await db.getConfig('PHONE_91_PREFIX_ENABLED', '0');
  return { enabled: String(v) === '1' };
}

async function api_phone91_set(token, payload) {
  await _admin(token);
  const on = !!(payload && payload.enabled);
  await db.setConfig('PHONE_91_PREFIX_ENABLED', on ? '1' : '0');
  return { ok: true, enabled: on };
}

async function api_phone91_preview(token, opts) {
  await _admin(token);
  opts = opts || {};
  const limit = Math.min(Number(opts.limit || 500), 10000);
  try { await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_raw TEXT`); } catch (_) {}
  const r = await db.query(
    `SELECT id, name, phone, whatsapp FROM leads
      WHERE phone IS NOT NULL AND phone <> ''
      ORDER BY id DESC LIMIT ${limit}`
  );
  let changed = 0, invalid = 0, unchanged = 0;
  const preview = [];
  const seenPhone = {};
  const dupes = [];
  r.rows.forEach(row => {
    const nv = normalize91(row.phone);
    const nw = row.whatsapp ? normalize91(row.whatsapp) : row.whatsapp;
    const ok = /^\+91\d{10}$/.test(nv);
    if (!ok) invalid++;
    if (nv === row.phone && nw === row.whatsapp) unchanged++;
    else changed++;
    preview.push({
      id: row.id, name: row.name || '',
      before_phone: row.phone || '', after_phone: nv || '',
      before_wa: row.whatsapp || '', after_wa: nw || '',
      valid: ok, changed: nv !== row.phone || nw !== row.whatsapp
    });
    if (nv) {
      if (seenPhone[nv]) dupes.push({ id: row.id, other_id: seenPhone[nv], normalized: nv });
      else seenPhone[nv] = row.id;
    }
  });
  return { total: r.rows.length, changed, invalid, unchanged, dupes, preview: preview.slice(0, 200) };
}

async function api_phone91_apply(token, opts) {
  await _admin(token);
  opts = opts || {};
  const limit = Math.min(Number(opts.limit || 100000), 500000);
  try { await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_raw TEXT`); } catch (_) {}
  const r = await db.query(
    `SELECT id, phone, whatsapp FROM leads
      WHERE phone IS NOT NULL AND phone <> ''
      ORDER BY id ASC LIMIT ${limit}`
  );
  let updated = 0, unchanged = 0, invalid = 0;
  for (const row of r.rows) {
    const nv = normalize91(row.phone);
    const nw = row.whatsapp ? normalize91(row.whatsapp) : row.whatsapp;
    if (!/^\+91\d{10}$/.test(nv)) { invalid++; continue; }
    if (nv === row.phone && nw === row.whatsapp) { unchanged++; continue; }
    try {
      await db.query(
        `UPDATE leads SET phone_raw = COALESCE(phone_raw, phone), phone = $2, whatsapp = $3 WHERE id = $1`,
        [row.id, nv, nw || row.whatsapp || null]
      );
      updated++;
    } catch (_) { invalid++; }
  }
  return { scanned: r.rows.length, updated, unchanged, invalid };
}

module.exports = {
  api_phone91_get, api_phone91_set, api_phone91_preview, api_phone91_apply
};
