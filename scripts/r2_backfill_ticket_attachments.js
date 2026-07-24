#!/usr/bin/env node
/**
 * R2_STORE_v1 — backfill existing ticket attachments (control DB) into R2.
 *
 * NON-DESTRUCTIVE: reads file_bytes, uploads a copy to R2, records r2_key.
 * It NEVER deletes, nulls, or modifies file_bytes. Safe to run repeatedly —
 * it only touches rows where r2_key IS NULL. Ctrl-C anytime; rerun to resume.
 *
 * Run on Railway (so it uses the same DB + R2 env as production):
 *   railway run node scripts/r2_backfill_ticket_attachments.js
 *   railway run node scripts/r2_backfill_ticket_attachments.js --dry   # count only
 *
 * Requires R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PRIVATE_BUCKET.
 * R2_OFFLOAD does not need to be 'on' for backfill — this pre-populates keys so
 * you can flip 'on' afterward with everything already in place.
 */
'use strict';
const control = require('../control/db');
const r2store = require('../utils/r2store');

const DRY = process.argv.includes('--dry');
const BATCH = 25;

async function main() {
  if (!r2store.isConfigured()) {
    console.error('R2 not configured (need R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_PRIVATE_BUCKET). Aborting.');
    process.exit(2);
  }
  await control.query(`ALTER TABLE support_ticket_attachments ADD COLUMN IF NOT EXISTS r2_key TEXT`).catch(() => {});

  const { rows: [{ c: pending }] } = await control.query(
    `SELECT COUNT(*)::int AS c FROM support_ticket_attachments WHERE r2_key IS NULL AND file_bytes IS NOT NULL`);
  console.log(`Attachments needing backfill: ${pending}`);
  if (DRY) { console.log('(dry run — nothing uploaded)'); process.exit(0); }
  if (!pending) { console.log('Nothing to do.'); process.exit(0); }

  let done = 0, failed = 0;
  for (;;) {
    const { rows } = await control.query(
      `SELECT a.id, a.ticket_id, a.filename, a.mime_type, a.file_bytes,
              t.tenant_slug
         FROM support_ticket_attachments a
         JOIN support_tickets t ON t.id = a.ticket_id
        WHERE a.r2_key IS NULL AND a.file_bytes IS NOT NULL
        ORDER BY a.id ASC
        LIMIT ${BATCH}`);
    if (!rows.length) break;
    for (const a of rows) {
      try {
        let buf = a.file_bytes;
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
        const key = await r2store.put({
          tenant: a.tenant_slug || 'unknown',
          category: 'attachments',
          subPath: 'tickets/' + a.ticket_id,
          filename: a.id + '-' + (a.filename || 'file'),
          body: buf,
          contentType: a.mime_type || 'application/octet-stream',
        });
        // verify the copy landed before recording the key
        const back = await r2store.getBuffer(key, 'attachments');
        if (back.length !== buf.length) throw new Error(`size mismatch (${back.length} vs ${buf.length})`);
        await control.query('UPDATE support_ticket_attachments SET r2_key = $1 WHERE id = $2', [key, a.id]);
        done++;
        if (done % 20 === 0) console.log(`  …${done}/${pending}`);
      } catch (e) {
        failed++;
        console.warn(`  ! attachment ${a.id} failed: ${e.message} (left on BYTEA, will retry next run)`);
      }
    }
  }
  console.log(`Done. Uploaded ${done}, failed ${failed}. BYTEA untouched for every row.`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
