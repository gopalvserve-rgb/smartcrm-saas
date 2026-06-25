/**
 * routes/subStatuses.js — SUB_STATUS_v1 (Vserve-only beta)
 *
 * Optional second-level dropdown under each status. Admin creates
 * entries like "Not Interested" → "Price too high", "Already using
 * competitor". When a rep picks a parent status that has any active
 * children, the lead modal shows a 2nd dropdown.
 *
 * Surface:
 *   api_subStatuses_list      — all rows (optionally filter by parent)
 *   api_subStatuses_save      — admin create / update
 *   api_subStatuses_delete    — admin remove
 *
 * Gate:
 *   Tenant config SUB_STATUS_ENABLED='1' (Vserve auto-enabled at boot).
 *
 * Schema (created lazily by _ensureSchema):
 *   sub_statuses ( id, parent_status_id, name, color, sort_order,
 *                  is_active, is_required, created_at, updated_at )
 *   leads.sub_status_id INTEGER NULL — points to sub_statuses.id
 */

'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const _ensured = new WeakSet();
async function _ensureSchema() {
  let pool = null;
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    pool = store && store.pool;
  } catch (_) {}
  if (pool && _ensured.has(pool)) return;
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS sub_statuses (
      id                SERIAL PRIMARY KEY,
      parent_status_id  INTEGER NOT NULL,
      name              TEXT NOT NULL,
      color             TEXT NOT NULL DEFAULT '#94a3b8',
      sort_order        INTEGER NOT NULL DEFAULT 10,
      is_active         INTEGER NOT NULL DEFAULT 1,
      is_required       INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sub_statuses_parent ON sub_statuses(parent_status_id)`);
    await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS sub_status_id INTEGER`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_leads_sub_status ON leads(sub_status_id)`);
    if (pool) _ensured.add(pool);
  } catch (e) {
    console.warn('[subStatuses] _ensureSchema failed:', e.message);
  }
}

async function _requireAuth(token) {
  return await authUser(token);
}
async function _requireAdmin(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  return me;
}

async function api_subStatuses_list(token, filters) {
  await _requireAuth(token);
  await _ensureSchema();
  const f = filters || {};
  const where = [];
  const params = [];
  if (f.parent_status_id) {
    params.push(Number(f.parent_status_id));
    where.push('parent_status_id = $' + params.length);
  }
  if (f.active_only) {
    where.push('COALESCE(is_active, 1) = 1');
  }
  const sql = `SELECT id, parent_status_id, name, color, sort_order, is_active, is_required,
                      created_at, updated_at
                 FROM sub_statuses
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY parent_status_id ASC, sort_order ASC, id ASC`;
  const r = await db.query(sql, params);
  return r.rows;
}

async function api_subStatuses_save(token, payload) {
  await _requireAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  const name = String(p.name || '').trim();
  const parentId = Number(p.parent_status_id);
  if (!name) throw new Error('name required');
  if (!parentId) throw new Error('parent_status_id required');
  const color = String(p.color || '#94a3b8').trim();
  const sortOrder = Number(p.sort_order) || 10;
  const isActive = p.is_active === false || Number(p.is_active) === 0 ? 0 : 1;
  const isRequired = p.is_required ? 1 : 0;

  if (p.id) {
    // Update
    await db.query(
      `UPDATE sub_statuses
          SET parent_status_id = $1, name = $2, color = $3, sort_order = $4,
              is_active = $5, is_required = $6, updated_at = NOW()
        WHERE id = $7`,
      [parentId, name, color, sortOrder, isActive, isRequired, Number(p.id)]
    );
    return { ok: true, id: Number(p.id) };
  }
  // Insert
  const r = await db.query(
    `INSERT INTO sub_statuses (parent_status_id, name, color, sort_order, is_active, is_required)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [parentId, name, color, sortOrder, isActive, isRequired]
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_subStatuses_delete(token, id) {
  await _requireAdmin(token);
  await _ensureSchema();
  if (!id) throw new Error('id required');
  // Soft-disable rather than hard-delete so existing lead rows keep
  // their reference (read-only badge). Admin can hard-delete via DB
  // if they really need to purge.
  await db.query(`UPDATE sub_statuses SET is_active = 0, updated_at = NOW() WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

// Bulk reorder helper — used by drag-and-drop in Settings.
async function api_subStatuses_reorder(token, payload) {
  await _requireAdmin(token);
  await _ensureSchema();
  const ids = (payload && payload.ids) || [];
  if (!Array.isArray(ids) || !ids.length) return { ok: true };
  for (let i = 0; i < ids.length; i++) {
    await db.query(`UPDATE sub_statuses SET sort_order = $1 WHERE id = $2`, [(i + 1) * 10, Number(ids[i])]);
  }
  return { ok: true };
}

module.exports = {
  api_subStatuses_list,
  api_subStatuses_save,
  api_subStatuses_delete,
  api_subStatuses_reorder
};
