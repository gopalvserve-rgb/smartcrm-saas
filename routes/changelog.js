// CHANGELOG_v1 (2026-05-28)
// ============================================================
// "What's New" / changelog timeline. The actual entries live in the
// CONTROL DB (shared across all tenants) so the platform owner can
// publish once and every tenant sees the same updates.
//
// Per-user "last seen" pointer is stored in the TENANT db's config
// table under key `user_changelog_seen:<user_id>` so the unread
// badge works per-user without cross-tenant chatter.
//
// Categories:
//   feature - "New Feature"      (icon: ✨)
//   fix     - "Issue Resolved"   (icon: 🛠)
//   modify  - "Upgrade / Modify" (icon: ⚡)
// ============================================================

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

let _control = null;
function _ctrl() {
  if (_control) return _control;
  try { _control = require('../control/db'); }
  catch (e) { console.warn('[changelog] control DB not available:', e.message); }
  return _control;
}

let _healed = false;
async function _heal() {
  if (_healed) return;
  const c = _ctrl();
  if (!c) return;
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS changelog (
        id          SERIAL PRIMARY KEY,
        category    TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        link        TEXT,
        icon        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_changelog_created  ON changelog(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_changelog_category ON changelog(category);
    `);
    _healed = true;
  } catch (e) {
    console.warn('[changelog] heal failed:', e.message);
  }
}

async function api_changelog_list(token, payload) {
  await authUser(token);
  await _heal();
  const c = _ctrl();
  if (!c) return { entries: [], counts: { feature: 0, fix: 0, modify: 0 } };
  const p = payload || {};
  const limit = Math.min(500, Math.max(1, Number(p.limit) || 200));
  let where = "created_at >= NOW() - INTERVAL '1 year'";
  const args = [];
  if (p.category && ['feature', 'fix', 'modify'].includes(String(p.category))) {
    args.push(String(p.category));
    where += ` AND category = $${args.length}`;
  }
  if (p.since) {
    args.push(String(p.since));
    where += ` AND created_at > $${args.length}::timestamptz`;
  }
  const r = await c.query(
    `SELECT id, category, title, body, link, icon, created_at
       FROM changelog
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    args
  );
  const cr = await c.query(
    `SELECT category, COUNT(*)::int AS n
       FROM changelog
      WHERE created_at >= NOW() - INTERVAL '1 year'
      GROUP BY category`,
    []
  );
  const counts = { feature: 0, fix: 0, modify: 0 };
  (cr.rows || []).forEach(row => { counts[row.category] = Number(row.n) || 0; });
  return { entries: r.rows || [], counts };
}

async function api_changelog_unread(token) {
  const me = await authUser(token);
  await _heal();
  const c = _ctrl();
  if (!c) return { count: 0, last_seen_at: null };

  const cfgKey = 'user_changelog_seen:' + me.id;
  let lastSeen = null;
  try {
    const row = await db.findOneBy('config', 'key', cfgKey);
    if (row && row.value) lastSeen = row.value;
  } catch (_) {}

  let count = 0;
  if (lastSeen) {
    const r = await c.query(
      `SELECT COUNT(*)::int AS n FROM changelog WHERE created_at > $1::timestamptz`,
      [lastSeen]
    );
    count = Number(r.rows[0] && r.rows[0].n) || 0;
  } else {
    const r = await c.query(
      `SELECT COUNT(*)::int AS n FROM changelog WHERE created_at >= NOW() - INTERVAL '30 days'`,
      []
    );
    count = Number(r.rows[0] && r.rows[0].n) || 0;
  }
  return { count, last_seen_at: lastSeen };
}

async function api_changelog_mark_seen(token) {
  const me = await authUser(token);
  const cfgKey = 'user_changelog_seen:' + me.id;
  const nowIso = new Date().toISOString();
  try {
    await db.query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [cfgKey, nowIso]
    );
  } catch (e) {
    try { await db.setConfig(cfgKey, nowIso); } catch (_) {}
  }
  return { ok: true, last_seen_at: nowIso };
}

async function api_changelog_publish(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Forbidden: admins only');
  await _heal();
  const c = _ctrl();
  if (!c) throw new Error('Control DB not configured on this deploy');
  const p = payload || {};
  const category = String(p.category || '').toLowerCase();
  if (!['feature', 'fix', 'modify'].includes(category)) throw new Error('Invalid category — use feature / fix / modify');
  const title = String(p.title || '').trim();
  if (!title) throw new Error('Title is required');
  const body  = String(p.body || '').trim();
  const link  = p.link ? String(p.link).trim() : null;
  const icon  = p.icon ? String(p.icon).trim() : null;
  const r = await c.query(
    `INSERT INTO changelog (category, title, body, link, icon)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, category, title, body, link, icon, created_at`,
    [category, title, body, link, icon]
  );
  return { ok: true, entry: r.rows[0] };
}

module.exports = {
  api_changelog_list,
  api_changelog_unread,
  api_changelog_mark_seen,
  api_changelog_publish
};
