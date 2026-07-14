/**
 * CALL_EVENT_COLS_TENANT_FIX_v1 (2026-07-13)
 * ==========================================
 * Self-healing ALTER for the call_events columns added by CALLLOG_SYNC_v1
 * (sim_slot, sim_label, src).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The ALTER used to live in routes/callLogSync.js behind a module-level boolean:
 *
 *     let _cols = false;
 *     async function _ensureCols() {
 *       if (_cols) return;                 // <-- per PROCESS, not per TENANT
 *       await db.query('ALTER TABLE call_events ADD COLUMN IF NOT EXISTS ...');
 *       _cols = true;
 *     }
 *
 * One Node process serves every tenant, and each tenant has its OWN database.
 * So the first tenant to trigger it flipped `_cols = true` for the whole process
 * and **every other tenant's DB never got the columns**. Those tenants then blew
 * up the moment anything read the new columns:
 *
 *     column ce.src does not exist        <- tenant `learnimo`, Call Activity, 500
 *
 * The guard has to be keyed by TENANT, and the ensure has to be called by every
 * route that touches these columns — not just the one that writes them. The
 * reporting routes read `ce.src` but never wrote a call-log row, so on a tenant
 * that had never run a sync the column simply wasn't there.
 *
 * This is the same failure family as the per-tenant config cache in
 * routes/recordings.js (see CLAUDE_PRIMER "3.4 Per-tenant config cache"): any
 * cache in this codebase MUST be keyed by tenant, or it leaks across tenants.
 *
 * Cheap: one Set lookup after the first call per tenant per process.
 */
const db = require('../db/pg');

const _done = new Set();

function _slug() {
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    return (store && store.slug) ? String(store.slug) : '__default__';
  } catch (_) {
    return '__default__';
  }
}

/**
 * Idempotent. Safe to await on any request path, on any tenant.
 * ADD COLUMN IF NOT EXISTS means a tenant that already has the columns pays
 * nothing but a no-op DDL on the first call of the process.
 */
async function ensureCallEventCols() {
  const slug = _slug();
  if (_done.has(slug)) return;
  try {
    await db.query(
      `ALTER TABLE call_events
         ADD COLUMN IF NOT EXISTS sim_slot  INTEGER,
         ADD COLUMN IF NOT EXISTS sim_label TEXT,
         ADD COLUMN IF NOT EXISTS src       TEXT`
    );
    _done.add(slug);   // only mark done if it actually succeeded
  } catch (e) {
    // Do NOT mark done — a transient failure must be retried on the next request,
    // otherwise we recreate the original bug in a slower form.
    try { console.warn('[callEventCols] ensure failed for', slug, e.message); } catch (_) {}
  }
}

module.exports = { ensureCallEventCols };
