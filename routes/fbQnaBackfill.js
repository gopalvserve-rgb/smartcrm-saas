/**
 * routes/fbQnaBackfill.js  —  FB_META_QNA_BACKFILL_v1 (2026-07-05)
 *
 * Backfill historical Facebook leads whose Q&A ended up only in the
 * `notes` column (FB_META_QNA_NOTES_v2, 2026-07-03) and never got the
 * timeline Remark row that new leads now get (FB_META_QNA_REMARK_v1).
 *
 * Idempotent: skips a lead if we already inserted a remark with the same
 * "📋 Facebook form answers:" prefix.
 *
 * Admin API:
 *   api_fbQnaBackfill_run({ dry_run:true|false, limit:500 })
 *     → { scanned, matched, inserted, skipped, examples: [{lead_id, preview}] }
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const REMARK_PREFIX = '📋 Facebook form answers:';

async function api_fbQnaBackfill_run(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Only admins can run the FB Q&A backfill');
  const p = payload || {};
  const dryRun = p.dry_run !== false;   // default: dry-run
  const limit  = Math.min(Math.max(Number(p.limit || 500), 1), 5000);

  // 1. Find leads whose notes contain a "Form answers:" block.
  //    Match either the ingestion prefix "Form answers:\n" (from
  //    FB_META_QNA_NOTES_v2) or the new remark prefix.
  const cand = await db.query(
    `SELECT id, notes FROM leads
      WHERE notes LIKE '%Form answers:%' OR notes LIKE '%📋 Facebook form answers:%'
      ORDER BY id DESC LIMIT $1`,
    [limit]
  );

  const out = { scanned: cand.rows.length, matched: 0, inserted: 0, skipped: 0, examples: [] };

  for (const row of cand.rows) {
    // 2. Extract the Q&A block from notes.
    const notes = String(row.notes || '');
    const idx = notes.indexOf('Form answers:');
    if (idx < 0) { out.skipped++; continue; }
    // Take everything after "Form answers:\n" until end-of-notes or the next blank line.
    let block = notes.slice(idx + 'Form answers:'.length).replace(/^\r?\n/, '');
    // Cut at [DUPLICATE ...] or ⚠ marker if present (see _createLeadFromWebhook)
    const cutIdx = block.search(/\n\s*\[DUPLICATE|\n\s*⚠/);
    if (cutIdx > 0) block = block.slice(0, cutIdx);
    block = block.trim();
    if (!block) { out.skipped++; continue; }

    out.matched++;

    // 3. Idempotency — skip if a remark with the prefix already exists.
    const ex = await db.query(
      `SELECT id FROM remarks WHERE lead_id=$1 AND remark LIKE $2 LIMIT 1`,
      [row.id, REMARK_PREFIX + '%']
    );
    if (ex.rows.length) { out.skipped++; continue; }

    if (out.examples.length < 5) {
      out.examples.push({ lead_id: row.id, preview: block.slice(0, 200) });
    }

    if (!dryRun) {
      try {
        await db.query(
          `INSERT INTO remarks (lead_id, user_id, remark, created_at)
           VALUES ($1, NULL, $2, NOW())`,
          [row.id, REMARK_PREFIX + '\n' + block]
        );
        out.inserted++;
      } catch (e) {
        console.warn('[fbQnaBackfill] insert failed for lead', row.id, ':', e.message);
        out.skipped++;
      }
    }
  }

  return { dry_run: dryRun, ...out };
}

module.exports = { api_fbQnaBackfill_run };
