/**
 * routes/packs/_framework.js — Industry Pack framework
 *
 * Lets a super-admin install/uninstall an "industry pack" on a tenant.
 * A pack is a bundle of:
 *   - SQL schema (idempotent, namespaced — never collides with base tables)
 *   - Seed data (sample products, statuses, custom fields, WhatsApp templates)
 *   - Routes / APIs that get loaded only when the pack is active
 *   - Nav items in the tenant SPA that appear only when the pack is active
 *
 * Tenants on no pack stay on "Generic" — same experience they have today.
 * Installing a pack is purely additive — never drops or renames base tables.
 *
 * Mutual exclusivity (added 2026-05-20 — task #442):
 *   A tenant can only have ONE active pack at a time. When installPack is
 *   called we explicitly deactivate every other row in installed_packs first,
 *   then activate the target. Previously two packs could simultaneously have
 *   is_active=1, which caused Education + Real Estate sidebar items to both
 *   render on Generic / mismatched tenants.
 *
 * Storage:
 *   - control.industry_packs        — global pack registry (one row per pack id)
 *   - <tenant_db>.installed_packs   — which packs are active in this tenant
 *
 * Public API surface:
 *   listAvailablePacks()                       — returns all known packs
 *   listInstalledPacks(opts)                   — returns packs for tenant.
 *                                                Default activeOnly=true.
 *   installPack(packId, opts)                  — runs the pack's installer;
 *                                                deactivates other packs.
 *   uninstallPack(packId, opts)                — soft-disable (data kept).
 *   isPackActive(packId)                       — runtime check inside tenant ctx.
 */
'use strict';

const db = require('../../db/pg');

// ─────────────────────────────────────────────────────────────────
// Pack registry — each pack module self-registers on require.
// Keys are stable pack IDs used in DB rows and URLs.
// ─────────────────────────────────────────────────────────────────
const REGISTRY = {};

function register(pack) {
  if (!pack || !pack.id) throw new Error('pack must have id');
  REGISTRY[pack.id] = pack;
}

function listAvailablePacks() {
  return Object.values(REGISTRY).map(p => ({
    id: p.id,
    name: p.name,
    industry: p.industry,
    summary: p.summary,
    features: p.features || [],
    nav_items: (p.nav_items || []).map(n => ({ id: n.id, label: n.label, icon: n.icon })),
    version: p.version || '1.0.0'
  }));
}

// ─────────────────────────────────────────────────────────────────
// Schema for the installed_packs table inside each tenant DB.
// Idempotent — called on every install attempt.
// ─────────────────────────────────────────────────────────────────
async function _ensureInstalledPacksSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS installed_packs (
    pack_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    installed_by INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT ''
  )`);
}

/**
 * List installed packs. By default returns only active rows (is_active=1)
 * — the SPA's sidebar gate needs active packs, and historically returning
 * inactive rows made the gate leak (Education menu showing on Generic).
 * Pass { activeOnly: false } to get every row (super-admin diagnostics).
 */
async function listInstalledPacks(opts) {
  await _ensureInstalledPacksSchema();
  const activeOnly = !opts || opts.activeOnly !== false;
  const sql = activeOnly
    ? `SELECT pack_id, version, is_active, installed_at FROM installed_packs WHERE is_active = 1 ORDER BY installed_at DESC`
    : `SELECT pack_id, version, is_active, installed_at FROM installed_packs ORDER BY installed_at DESC`;
  const r = await db.query(sql);
  return r.rows;
}

async function isPackActive(packId) {
  try {
    await _ensureInstalledPacksSchema();
    const r = await db.query(`SELECT 1 FROM installed_packs WHERE pack_id = $1 AND is_active = 1 LIMIT 1`, [packId]);
    return !!r.rows[0];
  } catch (_) { return false; }
}

async function installPack(packId, opts) {
  const pack = REGISTRY[packId];
  if (!pack) throw new Error('Unknown pack: ' + packId);
  if (typeof pack.install !== 'function') throw new Error('Pack ' + packId + ' has no installer');
  await _ensureInstalledPacksSchema();
  // Run installer
  await pack.install(opts || {});
  // MUTEX: a tenant gets exactly ONE active pack. Deactivate every other
  // row BEFORE flipping the target on, so a buggy past install (or a
  // double self-heal between admin.js and tenantApi.js) can never leave
  // two packs both is_active=1 — which would cause both their sidebar
  // items to render.
  await db.query(`UPDATE installed_packs SET is_active = 0 WHERE pack_id <> $1`, [pack.id]);
  // Mark installed (or refresh version)
  await db.query(
    `INSERT INTO installed_packs (pack_id, version, installed_by, is_active)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (pack_id) DO UPDATE SET
       version = EXCLUDED.version,
       is_active = 1,
       installed_at = NOW()`,
    [pack.id, pack.version || '1.0.0', opts && opts.userId || null]
  );
  return { ok: true, pack_id: pack.id, version: pack.version || '1.0.0' };
}

async function uninstallPack(packId, opts) {
  const pack = REGISTRY[packId];
  if (!pack) throw new Error('Unknown pack: ' + packId);
  await _ensureInstalledPacksSchema();
  // Soft-disable by default — data kept
  await db.query(`UPDATE installed_packs SET is_active = 0 WHERE pack_id = $1`, [pack.id]);
  if (typeof pack.uninstall === 'function') {
    await pack.uninstall(opts || {});
  }
  return { ok: true, pack_id: pack.id };
}

/**
 * One-shot reconciler — used by listInstalledPacks self-heal paths.
 * If the table has 2+ active rows (legacy data from before the mutex),
 * keep only the most recent and deactivate the rest. Safe to call
 * frequently; no-op when already clean.
 */
async function _reconcileActivePacks() {
  try {
    await _ensureInstalledPacksSchema();
    const r = await db.query(`SELECT pack_id, installed_at FROM installed_packs WHERE is_active = 1 ORDER BY installed_at DESC`);
    if (!r.rows || r.rows.length <= 1) return;
    // Keep first (most recent), deactivate everything older
    const keep = r.rows[0].pack_id;
    await db.query(`UPDATE installed_packs SET is_active = 0 WHERE pack_id <> $1`, [keep]);
    console.log('[packs] reconcileActivePacks: kept', keep, 'deactivated', r.rows.length - 1, 'older row(s)');
  } catch (e) {
    console.warn('[packs] reconcileActivePacks failed:', e.message);
  }
}

module.exports = {
  register,
  listAvailablePacks,
  listInstalledPacks,
  isPackActive,
  installPack,
  uninstallPack,
  _ensureInstalledPacksSchema,
  _reconcileActivePacks
};

// Auto-register all packs in this folder (each pack file calls .register())
// Pack files self-register at load time, so requiring them is enough.
try { require('./education'); } catch (e) { console.warn('[packs] education load:', e.message); }
try { require('./realestate'); } catch (e) { console.warn('[packs] realestate load:', e.message); }
// PACK_PHASE_2_v1 — 2026-06-07 — Finance/Solar/Manufacturer/Holiday/Ecommerce
try { require('./finance');      } catch (e) { console.warn('[packs] finance load:', e.message); }
try { require('./solar');        } catch (e) { console.warn('[packs] solar load:', e.message); }
try { require('./manufacturer'); } catch (e) { console.warn('[packs] manufacturer load:', e.message); }
try { require('./holiday');      } catch (e) { console.warn('[packs] holiday load:', e.message); }
try { require('./ecommerce');    } catch (e) { console.warn('[packs] ecommerce load:', e.message); }
