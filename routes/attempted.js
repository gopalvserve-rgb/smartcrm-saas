/* ============================================================================
 * ATTEMPTED_STATUS_v1 (2026-07-16) — vserve only
 * ============================================================================
 * Gopal: "The lead which is called and not updated by user — can system mark that
 * status Attempted. Implement only on vserve not on other."
 *
 * THE PROBLEM IT SOLVES
 *   A rep dials a lead, nobody picks up (or they do and the rep forgets), and the lead
 *   sits in "New" forever. From the dashboard it looks untouched — indistinguishable
 *   from a lead nobody has ever called. Managers chase leads that were already tried.
 *
 * WHAT COUNTS AS AN ATTEMPT (Gopal's choice, deliberately strict)
 *   ONLY a call the PHONE'S CALL LOG confirms — src IN ('calllog','calllog-fix').
 *   NOT `dial_requested`: that is a TAP on the Call button, not a call. It is written
 *   the instant the rep taps, even if the call never connected, even on a mis-tap.
 *   Live example that made this decision easy: lead 3789 "Paras" shows a 📞 2× badge
 *   built from TWO dial_requested rows — no confirmed call exists. Marking that lead
 *   "Attempted" would be a lie told by the CRM.
 *   0-second / no-answer calls DO count — the rep genuinely tried.
 *
 * WHEN IT FIRES (Gopal's choice, the safest rule)
 *   ONLY leads still sitting in "New". If a rep has already chosen ANY other status,
 *   we never touch it — the sweep can't overwrite real human work. That single
 *   constraint is what makes this safe to run unattended.
 *
 * WHY A SWEEP AND NOT A HOOK IN THE SYNC
 *   The natural place is inside api_call_logSyncBatch — mark the lead as the call
 *   lands. But routes/callLogSync.js and routes/recordings.js are LOCKED (see
 *   LOCKED_FILES.md, standing order 2026-07-15: "Insure There Should not Be Any
 *   Changes in Current, Recording setup, Call Activity"). So this lives entirely
 *   outside them and only READS call_events. Nothing in the locked set changes.
 *
 * SAFETY
 *   - vserve only, by slug. Every other tenant is untouched, always.
 *   - Dry-run by default: apply must be passed explicitly.
 *   - Never creates the status silently on a tenant that isn't vserve.
 *   - Writes a lead_actions row so the change is visible in the timeline and
 *     attributable — a status that changes with no audit trail is how you lose trust.
 *
 * LIVES IN routes/ (not utils/) ON PURPOSE: routes/saas/tenantApi.js auto-registers any
 * exported api_* function from the files listed in ROUTE_FILES, and it resolves them with
 * require(`../${name}`) — i.e. routes/<name>.js. A util is never registered, so the
 * endpoints would 404 "Unknown function". Same trap as the SCHEMA/CONFIG_KEYS allowlists.
 * ========================================================================== */
const db = require('../db/pg');

const ATTEMPTED_NAME = 'Attempted';
const ALLOWED_SLUGS = ['vserve'];   // <-- the entire blast radius

function _slug() {
  try {
    const st = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    return (st && st.slug) ? String(st.slug) : '';
  } catch (_) { return ''; }
}
function isEnabled() { return ALLOWED_SLUGS.indexOf(_slug()) >= 0; }

/** The 'New' status id for this tenant (by name, case-insensitive). */
async function _newStatusId() {
  try {
    const r = await db.query(
      `SELECT id FROM statuses WHERE LOWER(TRIM(name)) = 'new' ORDER BY id ASC LIMIT 1`);
    return r.rows[0] ? Number(r.rows[0].id) : null;
  } catch (_) { return null; }
}

/**
 * Find (or create) the Attempted status. Created ONLY on an allowed tenant.
 * is_final = 0 — an attempted lead is very much still open, and marking it final
 * would hide it from the pool and from re-churn.
 */
async function ensureAttemptedStatus() {
  if (!isEnabled()) return null;
  try {
    const ex = await db.query(
      `SELECT id FROM statuses WHERE LOWER(TRIM(name)) = LOWER($1) LIMIT 1`, [ATTEMPTED_NAME]);
    if (ex.rows[0]) return Number(ex.rows[0].id);

    // Slot it right after New so the pipeline reads New -> Attempted -> ...
    let sort = 15;
    try {
      const n = await db.query(
        `SELECT COALESCE(sort_order, 0) AS s FROM statuses WHERE LOWER(TRIM(name)) = 'new' LIMIT 1`);
      if (n.rows[0]) sort = Number(n.rows[0].s) + 1;
    } catch (_) {}

    const ins = await db.query(
      `INSERT INTO statuses (name, color, sort_order, is_final) VALUES ($1, $2, $3, 0) RETURNING id`,
      [ATTEMPTED_NAME, '#f59e0b', sort]
    );
    const id = Number(ins.rows[0].id);
    console.log('[attempted] created "Attempted" status id=' + id + ' on ' + _slug());
    return id;
  } catch (e) {
    console.warn('[attempted] ensureAttemptedStatus failed:', e.message);
    return null;
  }
}

/**
 * The candidate query — leads that were really called but never updated.
 *
 *   status = New
 *   AND a CONFIRMED call exists for this lead (by lead_id OR phone tail — the same
 *       two-armed match the dial badge and the timeline use; a call_events row very
 *       often has lead_id = NULL, and matching on lead_id alone would miss most of them)
 *   AND that call is outbound-ish and came from the call log
 *   AND no status change has happened since (status is still New, so by definition true)
 */
async function _candidates(newId, limit) {
  const { rows } = await db.query(
    `SELECT l.id, l.name, l.phone, l.assigned_to,
            MAX(ce.created_at) AS last_call_at,
            COUNT(*)::int      AS calls
       FROM leads l
       JOIN call_events ce
         ON ( ce.lead_id = l.id
              OR ( COALESCE(l.phone,'') <> ''
                   AND right(regexp_replace(COALESCE(ce.phone,''), '[^0-9]', '', 'g'), 10)
                     = right(regexp_replace(COALESCE(l.phone,''),  '[^0-9]', '', 'g'), 10)
                   AND length(regexp_replace(COALESCE(l.phone,''), '[^0-9]', '', 'g')) >= 10 ) )
      WHERE l.status_id = $1
        AND COALESCE(ce.src,'') IN ('calllog', 'calllog-fix')
        AND COALESCE(ce.event,'') NOT IN ('dial_requested', 'autodial_requested', 'incoming_ringing')
        AND COALESCE(ce.direction,'') <> 'in'
      GROUP BY l.id, l.name, l.phone, l.assigned_to
      ORDER BY MAX(ce.created_at) DESC
      LIMIT $2`,
    [newId, limit]
  );
  return rows;
}

/**
 * api_leads_markAttempted(token, { apply, limit })
 * Admin-only. Dry-run unless apply === true.
 */
async function api_leads_markAttempted(token, payload) {
  const { authUser } = require('../utils/auth');
  const me = await authUser(token);
  if (String(me.role || '') !== 'admin') throw new Error('Admins only');
  if (!isEnabled()) {
    return { ok: true, enabled: false, slug: _slug(),
             note: 'Attempted auto-marking is enabled for vserve only.' };
  }
  const p = payload || {};
  const apply = p.apply === true || p.apply === 1 || p.apply === '1';
  const limit = Math.max(1, Math.min(Number(p.limit) || 500, 5000));

  const newId = await _newStatusId();
  if (!newId) return { ok: false, error: 'No "New" status on this tenant' };
  const attId = await ensureAttemptedStatus();
  if (!attId) return { ok: false, error: 'Could not create/find "Attempted" status' };
  if (Number(attId) === Number(newId)) return { ok: false, error: 'Attempted == New — refusing' };

  const rows = await _candidates(newId, limit);
  if (!apply) {
    return {
      ok: true, apply: false, enabled: true,
      new_status_id: newId, attempted_status_id: attId,
      would_mark: rows.length,
      sample: rows.slice(0, 20).map(r => ({
        id: r.id, name: r.name, phone: r.phone, calls: r.calls,
        last_call_at: r.last_call_at
      }))
    };
  }

  let marked = 0;
  for (const r of rows) {
    try {
      await db.query(
        `UPDATE leads SET status_id = $1, last_status_change_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND status_id = $3`,   // re-check status: a rep may have just updated it
        [attId, r.id, newId]
      );
      /* Audit trail — the timeline must show WHY the status moved. A silent status
       * change is indistinguishable from a bug, and reps will not trust it. */
      await db.query(
        `INSERT INTO lead_actions (lead_id, user_id, action_type, meta_json, created_at)
         VALUES ($1, $2, 'status_change', $3, NOW())`,
        [r.id, r.assigned_to || null, JSON.stringify({
          from_status_id: newId, to_status_id: attId,
          auto: true, reason: 'ATTEMPTED_STATUS_v1 — call log confirms ' + r.calls +
                              ' outbound call(s), lead never updated'
        })]
      ).catch(() => {});
      marked++;
    } catch (e) { console.warn('[attempted] lead ' + r.id + ':', e.message); }
  }
  console.log('[attempted] marked ' + marked + ' leads on ' + _slug());
  return { ok: true, apply: true, enabled: true, marked, scanned: rows.length };
}

/**
 * Dashboard counters. Read-only — safe on every tenant, returns enabled:false elsewhere.
 *   attempted            — leads currently in Attempted
 *   pending_for_attempt  — leads in New with NO confirmed call yet (the real "to call" queue)
 */
async function api_leads_attemptedCounts(token, payload) {
  const { authUser } = require('../utils/auth');
  await authUser(token);
  if (!isEnabled()) return { ok: true, enabled: false };
  const p = payload || {};
  const newId = await _newStatusId();
  const attId = await ensureAttemptedStatus();
  const out = { ok: true, enabled: true, attempted: 0, pending_for_attempt: 0,
                new_status_id: newId, attempted_status_id: attId };
  try {
    const a = await db.query(`SELECT COUNT(*)::int AS n FROM leads WHERE status_id = $1`, [attId]);
    out.attempted = Number(a.rows[0].n) || 0;
  } catch (_) {}
  try {
    const b = await db.query(
      `SELECT COUNT(*)::int AS n FROM leads l
        WHERE l.status_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM call_events ce
             WHERE ( ce.lead_id = l.id
                     OR ( COALESCE(l.phone,'') <> ''
                          AND right(regexp_replace(COALESCE(ce.phone,''), '[^0-9]', '', 'g'), 10)
                            = right(regexp_replace(COALESCE(l.phone,''),  '[^0-9]', '', 'g'), 10)
                          AND length(regexp_replace(COALESCE(l.phone,''), '[^0-9]', '', 'g')) >= 10 ) )
               AND COALESCE(ce.src,'') IN ('calllog','calllog-fix')
               AND COALESCE(ce.direction,'') <> 'in')`,
      [newId]
    );
    out.pending_for_attempt = Number(b.rows[0].n) || 0;
  } catch (_) {}
  return out;
}

/** Background pass — called per-tenant by the server sweep. vserve-only via isEnabled(). */
async function runOnce() {
  if (!isEnabled()) return;
  try {
    const { rows } = await db.query(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`);
    if (!rows[0]) return;
    const newId = await _newStatusId();
    const attId = await ensureAttemptedStatus();
    if (!newId || !attId || Number(newId) === Number(attId)) return;
    const cands = await _candidates(newId, 500);
    let n = 0;
    for (const r of cands) {
      try {
        const up = await db.query(
          `UPDATE leads SET status_id = $1, last_status_change_at = NOW(), updated_at = NOW()
            WHERE id = $2 AND status_id = $3`,
          [attId, r.id, newId]
        );
        if (up.rowCount) {
          await db.query(
            `INSERT INTO lead_actions (lead_id, user_id, action_type, meta_json, created_at)
             VALUES ($1, $2, 'status_change', $3, NOW())`,
            [r.id, r.assigned_to || null, JSON.stringify({
              from_status_id: newId, to_status_id: attId, auto: true,
              reason: 'ATTEMPTED_STATUS_v1 — call log confirms ' + r.calls + ' outbound call(s)'
            })]
          ).catch(() => {});
          n++;
        }
      } catch (_) {}
    }
    if (n) console.log('[attempted] sweep marked ' + n + ' leads on ' + _slug());
  } catch (e) { console.warn('[attempted] sweep failed:', e.message); }
}

module.exports = {
  isEnabled, ensureAttemptedStatus, runOnce,
  api_leads_markAttempted,
  api_leads_attemptedCounts
};
