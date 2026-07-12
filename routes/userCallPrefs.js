/**
 * routes/userCallPrefs.js — USER_CALL_PREFS_v1 (2026-07-12)
 *
 * PER-USER call settings, with the tenant config as the fallback default.
 *
 * Every call setting used to be tenant-wide (one value for the whole company),
 * which was wrong: each rep has their own phone, their own SIMs, and their own
 * way of working. Now:
 *
 *   effective value = the rep's own value, if they set one
 *                     otherwise the company default (tenant config)
 *                     otherwise a hard-coded safe default
 *
 * NULL in this table means "inherit the company default" — it is NOT the same
 * as 0. That distinction is the whole point, so never COALESCE it away on read.
 *
 * Admins may read/write any user's row; everyone else only their own.
 *
 * Uses RAW SQL throughout, so it does NOT depend on the db/pg.js SCHEMA
 * whitelist (adding a table there is a known footgun — see schema_cache_register).
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// Boolean-ish columns: stored as INTEGER 0/1, NULL = inherit.
const BOOL_COLS = [
  'sync_lead_only',      // only sync calls that match a lead
  'activity_lead_only',  // Call Activity shows lead-matched calls by default
  'capture_lead_only',   // only capture calls that match a lead
  'autolead_inbound',    // auto-create a lead for incoming/missed unknown numbers
  'autolead_outbound',   // auto-create a lead for outgoing unknown numbers
  'autosync_on_open'     // sync the phone call log on every app open
];
const INT_COLS  = ['autolead_min_seconds', 'autolead_status_id'];
// DIRECTION_SETS_v1 (2026-07-12) — the two settings people actually think in:
//   sync_directions     — which calls appear in Call Activity
//   autolead_directions — which calls become leads
// Each is a CSV subset of 'in','missed','out'. '' (empty string) = NONE, and that
// is a REAL value, distinct from NULL (= inherit the company default).
const TEXT_COLS = ['autolead_mode', 'autolead_on_duplicate', 'sim_slots',
                   'sync_directions', 'autolead_directions'];
const ALL_COLS  = BOOL_COLS.concat(INT_COLS, TEXT_COLS);

let _ready = false;
async function _ensure() {
  if (_ready) return;
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS user_call_prefs (
         user_id               INTEGER PRIMARY KEY,
         sync_lead_only        INTEGER,
         activity_lead_only    INTEGER,
         capture_lead_only     INTEGER,
         autolead_mode         TEXT,
         autolead_inbound      INTEGER,
         autolead_outbound     INTEGER,
         autolead_min_seconds  INTEGER,
         autolead_status_id    INTEGER,
         autolead_on_duplicate TEXT,
         autosync_on_open      INTEGER,
         sim_slots             TEXT,
         sync_directions       TEXT,
         autolead_directions   TEXT,
         updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
  } catch (e) { /* best-effort; a concurrent boot may have created it */ }
  // DIRECTION_SETS_v1 — added after the table shipped, so ALTER it in.
  try {
    await db.query(`ALTER TABLE user_call_prefs
      ADD COLUMN IF NOT EXISTS sync_directions     TEXT,
      ADD COLUMN IF NOT EXISTS autolead_directions TEXT`);
  } catch (e) { /* best-effort */ }
  _ready = true;
}

/** Normalise a CSV / array of directions to a clean sorted array of in|missed|out. */
function _dirs(v) {
  if (v === null || v === undefined) return null;          // null = inherit
  const raw = Array.isArray(v) ? v : String(v).split(',');
  const ok  = ['in', 'missed', 'out'];
  const out = [];
  raw.forEach(x => {
    const k = String(x || '').trim().toLowerCase();
    if (ok.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k);
  });
  return out;                                              // [] = explicitly NONE
}

/** The company-wide defaults (tenant config), with safe fallbacks. */
async function _companyDefaults() {
  const [syncLO, actLO, capLO, mode, inb, outb, minS, stId, dup, autoSync, syncDirs, alDirs] = await Promise.all([
    db.getConfig('CALLS_SYNC_LEAD_ONLY',      '0'),
    db.getConfig('CALL_ACTIVITY_LEAD_ONLY',   '0'),
    db.getConfig('CALL_CAPTURE_LEAD_ONLY',    '0'),
    db.getConfig('CALLS_AUTOLEAD_MODE',       'auto'),
    db.getConfig('CALLS_AUTOLEAD_INBOUND',    '0'),
    db.getConfig('CALLS_AUTOLEAD_OUTBOUND',   '0'),
    db.getConfig('CALLS_AUTOLEAD_MIN_SECONDS','5'),
    db.getConfig('CALLS_AUTOLEAD_STATUS_ID',  '0'),
    db.getConfig('CALLS_AUTOLEAD_ON_DUPLICATE','attach'),
    db.getConfig('CALLS_AUTOSYNC_ON_OPEN',    '1'),
    db.getConfig('CALLS_SYNC_DIRECTIONS',     'in,missed,out'),
    db.getConfig('CALLS_AUTOLEAD_DIRECTIONS', null)
  ]);
  // CONFIG_EMPTYSTRING_TRAP — a config row can be '' (not just missing), and
  // String('' || 'x') === 'x' would silently flip the meaning. Compare explicitly.
  const b = (v, d) => (v === null || v === undefined || v === '') ? d : (String(v) === '1');
  const t = (v, d) => (v === null || v === undefined || v === '') ? d : String(v);
  const n = (v, d) => {
    if (v === null || v === undefined || v === '') return d;
    const x = Number(v); return Number.isFinite(x) ? x : d;
  };
  return {
    sync_lead_only:        b(syncLO, false),
    activity_lead_only:    b(actLO,  false),
    capture_lead_only:     b(capLO,  false),
    autolead_mode:         t(mode,   'auto'),
    autolead_inbound:      b(inb,    false),
    autolead_outbound:     b(outb,   false),
    autolead_min_seconds:  n(minS,   5),
    autolead_status_id:    n(stId,   0),
    autolead_on_duplicate: t(dup,    'attach'),
    autosync_on_open:      b(autoSync, true),
    sim_slots:             '',    // no company-wide SIM default: it's per phone

    // DIRECTION_SETS_v1. Default: save everything, create nothing.
    sync_directions: (syncDirs === null || syncDirs === undefined)
      ? ['in', 'missed', 'out']
      : _dirs(syncDirs),
    // Legacy bridge: if the company never set CALLS_AUTOLEAD_DIRECTIONS, derive it
    // from the old inbound/outbound flags so nobody's existing behaviour changes.
    autolead_directions: (alDirs === null || alDirs === undefined)
      ? [].concat(b(inb, false) ? ['in', 'missed'] : [])
           .concat(b(outb, false) ? ['out'] : [])
      : _dirs(alDirs)
  };
}

/** This user's raw row (NULL = inherit). {} when they've never set anything.
 *
 *  CAPTURE_ONE_STORE_v1 (2026-07-12): `capture_lead_only` ALSO exists as a column
 *  on `users` (written by the old "Capture only my CRM-lead calls" toggle that used
 *  to live in the Security modal). Two stores for one policy is how settings drift
 *  apart, so this is the single reader: if user_call_prefs has no opinion, fall back
 *  to the legacy users column, then to the company default. Saving writes BOTH, so
 *  nothing that still reads the old column goes stale. */
async function _rawPrefs(userId) {
  await _ensure();
  let row = {};
  try {
    const { rows } = await db.query('SELECT * FROM user_call_prefs WHERE user_id = $1', [userId]);
    row = rows[0] || {};
  } catch (e) { row = {}; }

  if (row.capture_lead_only === null || row.capture_lead_only === undefined) {
    try {
      const { rows } = await db.query(
        'SELECT capture_lead_only FROM users WHERE id = $1', [userId]);
      const legacy = rows[0] && rows[0].capture_lead_only;
      // Only a legacy 1 counts as a real opt-in. A legacy 0 is just the column's
      // NOT NULL default and must NOT be read as "this rep explicitly chose No",
      // or nobody could ever inherit a company default of ON.
      if (Number(legacy) === 1) row.capture_lead_only = 1;
    } catch (e) { /* column may not exist on older tenants */ }
  }
  return row;
}

/**
 * THE function the rest of the server should call. Resolves a user's effective
 * settings: their own value where set, the company default otherwise.
 * Exported (not an api_ function) so recordings.js / callLogSync.js can use it.
 */
async function resolveCallPrefs(userId) {
  const [company, mine] = await Promise.all([_companyDefaults(), _rawPrefs(userId)]);
  const out = Object.assign({}, company);
  BOOL_COLS.forEach(k => { if (mine[k] !== null && mine[k] !== undefined) out[k] = Number(mine[k]) === 1; });
  INT_COLS.forEach(k  => { if (mine[k] !== null && mine[k] !== undefined) out[k] = Number(mine[k]); });
  TEXT_COLS.forEach(k => { if (mine[k] !== null && mine[k] !== undefined && mine[k] !== '') out[k] = String(mine[k]); });
  // sim_slots '' legitimately means "all SIMs", so honour an explicit empty string.
  if (mine.sim_slots !== null && mine.sim_slots !== undefined) out.sim_slots = String(mine.sim_slots);

  // DIRECTION_SETS_v1 — an empty string is an explicit "NONE" and must beat the
  // company default. Only NULL means "inherit".
  if (mine.sync_directions !== null && mine.sync_directions !== undefined) {
    out.sync_directions = _dirs(mine.sync_directions);
  }
  if (mine.autolead_directions !== null && mine.autolead_directions !== undefined) {
    out.autolead_directions = _dirs(mine.autolead_directions);
  } else if (mine.autolead_inbound !== null && mine.autolead_inbound !== undefined ||
             mine.autolead_outbound !== null && mine.autolead_outbound !== undefined) {
    // Legacy per-user flags, set before this screen existed.
    out.autolead_directions = []
      .concat(Number(mine.autolead_inbound)  === 1 ? ['in', 'missed'] : [])
      .concat(Number(mine.autolead_outbound) === 1 ? ['out'] : []);
  }
  return out;
}

function _isAdmin(me) { return String(me.role || '') === 'admin'; }

/**
 * api_userCallPrefs_get(token, userId?)
 * Returns { user_id, mine (raw, nulls = inherit), effective, company, is_admin }.
 * Non-admins may only read themselves.
 */
async function api_userCallPrefs_get(token, userId) {
  const me = await authUser(token);
  let uid = Number(userId) || me.id;
  if (uid !== me.id && !_isAdmin(me)) uid = me.id;   // never leak someone else's

  const [mine, company, effective] = await Promise.all([
    _rawPrefs(uid), _companyDefaults(), resolveCallPrefs(uid)
  ]);
  return { user_id: uid, mine, company, effective, is_admin: _isAdmin(me) };
}

/**
 * api_userCallPrefs_save(token, { userId?, patch })
 * `patch` values: null => clear the override (inherit the company default).
 * Non-admins may only save their own row.
 */
async function api_userCallPrefs_save(token, payload) {
  const me = await authUser(token);
  await _ensure();
  const p = payload || {};
  let uid = Number(p.userId) || me.id;
  if (uid !== me.id && !_isAdmin(me)) throw new Error('Not allowed to change another user\'s settings');

  const patch = p.patch || {};
  const cols = [], vals = [];
  Object.keys(patch).forEach(k => {
    if (ALL_COLS.indexOf(k) < 0) return;                 // ignore unknown keys
    let v = patch[k];
    if (v === null || v === undefined || v === '__inherit__') { v = null; }
    else if (BOOL_COLS.indexOf(k) >= 0) v = (v === true || v === 1 || v === '1') ? 1 : 0;
    else if (INT_COLS.indexOf(k) >= 0)  v = Number(v) || 0;
    else if (k === 'sync_directions' || k === 'autolead_directions') {
      // Array or CSV in; clean CSV out. '' is stored and MEANS "none" — not "inherit".
      v = (_dirs(v) || []).join(',');
    }
    else v = String(v);
    cols.push(k); vals.push(v);
  });
  if (!cols.length) return await api_userCallPrefs_get(token, uid);

  // UPSERT. Only the columns present in `patch` are touched; the rest keep
  // whatever they had (including NULL = inherit).
  const insCols = ['user_id'].concat(cols);
  const insVals = [uid].concat(vals);
  const ph = insVals.map((_, i) => '$' + (i + 1)).join(', ');
  const setStr = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await db.query(
    `INSERT INTO user_call_prefs (${insCols.join(', ')}) VALUES (${ph})
       ON CONFLICT (user_id) DO UPDATE SET ${setStr}, updated_at = NOW()`,
    insVals
  );

  // LEGACY_AUTOLEAD_SYNC_v1 (2026-07-12) — autolead_inbound / autolead_outbound are the
  // OLD per-user flags. resolveCallPrefs() still bridges from them when
  // autolead_directions is NULL, which meant a rep whose old flags said YES had an
  // EFFECTIVE value of in+missed+out while the new checkboxes rendered "None of them".
  // The screen said no leads; the server made leads. Whenever the new field is written,
  // drag the legacy flags into agreement so the two can never disagree again.
  if (Object.prototype.hasOwnProperty.call(patch, 'autolead_directions')) {
    const i = cols.indexOf('autolead_directions');
    if (i >= 0 && vals[i] !== null) {
      const set = String(vals[i]).split(',').filter(Boolean);
      const inb = (set.indexOf('in') >= 0 || set.indexOf('missed') >= 0) ? 1 : 0;
      const out = (set.indexOf('out') >= 0) ? 1 : 0;
      try {
        await db.query(
          `UPDATE user_call_prefs SET autolead_inbound = $1, autolead_outbound = $2 WHERE user_id = $3`,
          [inb, out, uid]);
      } catch (e) { /* best-effort */ }
    }
  }

  // CAPTURE_ONE_STORE_v1 — mirror into the legacy users.capture_lead_only column
  // so anything still reading it (and the old Security-modal toggle) stays in step.
  if (Object.prototype.hasOwnProperty.call(patch, 'capture_lead_only')) {
    const i = cols.indexOf('capture_lead_only');
    if (i >= 0) {
      const v = vals[i];
      // MIRROR_CLEAR_FIX_v1 (2026-07-12): users.capture_lead_only is NOT NULL, so
      // writing NULL to it threw, the catch swallowed it, and the old value stayed
      // stuck at 1 — leaving the rep permanently opted in to "capture only my
      // CRM-lead calls" with their non-lead calls silently dropped. The legacy column
      // has no "inherit" state, so clearing the override writes the COMPANY default
      // into it, which is what "inherit" resolves to anyway.
      let legacy;
      if (v === null) {
        const co = await _companyDefaults();
        legacy = co.capture_lead_only ? 1 : 0;
      } else {
        legacy = Number(v) === 1 ? 1 : 0;
      }
      try {
        await db.query('UPDATE users SET capture_lead_only = $1 WHERE id = $2', [legacy, uid]);
      } catch (e) { /* column may not exist on older tenants */ }
    }
  }
  return await api_userCallPrefs_get(token, uid);
}

/** Admin-only: everyone's settings at a glance (for the Users page). */
async function api_userCallPrefs_listAll(token) {
  const me = await authUser(token);
  if (!_isAdmin(me)) throw new Error('Admins only');
  await _ensure();
  const { rows } = await db.query(
    `SELECT u.id AS user_id, u.name, u.role, p.*
       FROM users u
       LEFT JOIN user_call_prefs p ON p.user_id = u.id
      WHERE COALESCE(u.is_active, 1) = 1
      ORDER BY u.name`
  );
  const company = await _companyDefaults();
  return { company, users: rows };
}

module.exports = {
  api_userCallPrefs_get,
  api_userCallPrefs_save,
  api_userCallPrefs_listAll,
  // internal, for other route files:
  resolveCallPrefs,
  _companyDefaults
};
