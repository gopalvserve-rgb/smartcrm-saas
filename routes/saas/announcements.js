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
  const displayMode = p.display_mode === 'popup' ? 'popup' : 'banner';
  const imageUrl = (p.image_url || '').toString().trim() || null;

  // Validation differs by mode:
  //  • banner needs a title + body (renders as a one-line strip).
  //  • popup needs a title and EITHER body text OR an image — an
  //    image-only promo is legitimate.
  if (!p.title) throw new Error('Title is required');
  if (displayMode === 'banner' && !p.body) throw new Error('Body is required for a banner');
  if (displayMode === 'popup' && !p.body && !imageUrl) {
    throw new Error('A popup needs body text or an image');
  }

  const data = {
    title: String(p.title).trim().slice(0, 200),
    body: String(p.body || ''),
    level: ['info', 'warn', 'critical', 'new_feature'].includes(p.level) ? p.level : 'info',
    starts_at: p.starts_at || control.nowIso(),
    ends_at:   p.ends_at || null,
    is_active: Number(p.is_active) === 0 ? 0 : 1,
    // POPUP_BROADCAST_v1
    display_mode: displayMode,
    image_url:    imageUrl,
    link_url:     (p.link_url || '').toString().trim() || null,
    cta_text:     (p.cta_text || '').toString().trim().slice(0, 40) || null,
    bg_color:     (p.bg_color || '').toString().trim() || null,
    text_color:   (p.text_color || '').toString().trim() || null,
    accent_color: (p.accent_color || '').toString().trim() || null,
    dismissible:  Number(p.dismissible) === 0 ? 0 : 1
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
    `SELECT id, title, body, level, starts_at, ends_at,
            display_mode, image_url, link_url, cta_text,
            bg_color, text_color, accent_color, dismissible
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
