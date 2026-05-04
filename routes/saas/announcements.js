/**
 * Platform-wide announcements ("Updates" tab in your screenshot).
 *
 * Admin posts one — every tenant CRM shows it as a banner at the top
 * of the dashboard until it expires or the user dismisses it.
 *
 * Public list is filtered to currently-active rows (now between
 * starts_at and ends_at). The tenant SPA polls this endpoint so we
 * never need to push updates.
 */
const control = require('../../control/db');
const { requireSuperAdmin, requireFullAdmin } = require('./superAdminAuth');

async function api_saas_announcements_listAdmin(token) {
  await requireSuperAdmin(token);
  const r = await control.query(`SELECT * FROM platform_announcements ORDER BY id DESC LIMIT 200`);
  return r.rows;
}

async function api_saas_announcements_save(token, payload) {
  await requireFullAdmin(token);
  const p = payload || {};
  if (!p.title || !p.body) throw new Error('Title and body are required');
  const data = {
    title: String(p.title).trim().slice(0, 200),
    body: String(p.body),
    level: ['info', 'warn', 'critical', 'new_feature'].includes(p.level) ? p.level : 'info',
    starts_at: p.starts_at || control.nowIso(),
    ends_at:   p.ends_at || null,
    is_active: Number(p.is_active) === 0 ? 0 : 1
  };
  if (p.id) {
    await control.update('platform_announcements', p.id, data);
    return { id: Number(p.id), ok: true };
  }
  const id = await control.insert('platform_announcements', data);
  return { id, ok: true };
}

async function api_saas_announcements_delete(token, id) {
  await requireFullAdmin(token);
  await control.update('platform_announcements', id, { is_active: 0 });
  return { ok: true };
}

/** Public endpoint — used by tenant CRMs to fetch active banners. */
async function api_saas_announcements_publicActive() {
  const r = await control.query(
    `SELECT id, title, body, level, starts_at, ends_at
       FROM platform_announcements
      WHERE is_active = 1
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (ends_at   IS NULL OR ends_at   >= NOW())
      ORDER BY id DESC LIMIT 10`
  );
  return r.rows;
}

module.exports = {
  api_saas_announcements_listAdmin,
  api_saas_announcements_save,
  api_saas_announcements_delete,
  api_saas_announcements_publicActive
};
