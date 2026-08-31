/**
 * routes/leadCallDuration.js — LEAD_LIST_CALL_DURATION_v1 (2026-08-29)
 *
 * Duration of the MOST RECENT outgoing call per lead, powering the optional
 * "Call Duration" column in the lead list.
 *
 * Matching is deliberately identical to routes/recordings.js::_dialCountMap —
 * lead_id OR last-10-digits of the phone — so this column can never disagree
 * with the 📞 dial-count badge or the "Last Dialed" column beside it. (Two
 * matchers for one fact is what put 108 recordings on the wrong customer.)
 *
 * routes/recordings.js is LOCKED, so this lives in its own file rather than
 * extending _dialCountMap in place.
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const MAX_IDS = 1000;
const P = `right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10)`;

async function api_leads_callDurations(token, leadIds) {
  await authUser(token);
  const ids = (Array.isArray(leadIds) ? leadIds : [])
    .map(Number).filter(Boolean).slice(0, MAX_IDS);
  const out = {};
  if (!ids.length) return out;

  const norm = p => String(p || '').replace(/\D/g, '').slice(-10);

  let leadRows = [];
  try {
    const r = await db.query(`SELECT id, phone FROM leads WHERE id = ANY($1::int[])`, [ids]);
    leadRows = r.rows || [];
  } catch (_) { return out; }

  const phones = [...new Set(leadRows.map(r => norm(r.phone)).filter(x => x.length >= 7))];

  // Latest outgoing call keyed by lead_id, and again keyed by phone tail.
  const byId = {}, byPhone = {};
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (lead_id) lead_id, created_at, COALESCE(duration_s,0)::int AS dur
         FROM call_events
        WHERE COALESCE(direction,'out') <> 'in' AND lead_id = ANY($1::int[])
        ORDER BY lead_id, created_at DESC`, [ids]);
    rows.forEach(r => { byId[r.lead_id] = { at: r.created_at, dur: Number(r.dur) || 0 }; });
  } catch (_) {}

  if (phones.length) {
    try {
      const { rows } = await db.query(
        `SELECT DISTINCT ON (${P}) ${P} AS ph, created_at, COALESCE(duration_s,0)::int AS dur
           FROM call_events
          WHERE COALESCE(direction,'out') <> 'in' AND ${P} = ANY($1::text[])
          ORDER BY ${P}, created_at DESC`, [phones]);
      rows.forEach(r => { if (r.ph) byPhone[r.ph] = { at: r.created_at, dur: Number(r.dur) || 0 }; });
    } catch (_) {}
  }

  const newer = (a, b) => {
    if (!a) return b || null;
    if (!b) return a;
    return new Date(a.at) >= new Date(b.at) ? a : b;
  };

  leadRows.forEach(r => {
    const pick = newer(byId[r.id] || null, byPhone[norm(r.phone)] || null);
    out[r.id] = pick ? { duration_s: pick.dur, at: pick.at } : { duration_s: null, at: null };
  });
  ids.forEach(id => { if (out[id] === undefined) out[id] = { duration_s: null, at: null }; });
  return out;
}

module.exports = { api_leads_callDurations };
