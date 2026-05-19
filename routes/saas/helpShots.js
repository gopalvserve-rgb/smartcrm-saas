/**
 * routes/saas/helpShots.js — HELP_SHOTS_v1
 *
 * Persistent screenshot store for the public Help guide. Captures land in
 * control.help_shots (name PK, png_bytes BYTEA) and are served back via
 * /api/saas/helpShot/:name → image/png. Persists across deploys because
 * the control DB is durable.
 *
 * Upload endpoint is intentionally public (no auth) — the only thing that
 * gets in is a base64 PNG with a name matching ^[a-z0-9_-]{1,80}$ and capped
 * at 3 MB. Used by the Claude-in-Chrome helper to bulk-upload real screenshots
 * captured from a live tenant session.
 */
const control = require('../../control/db');

let _ensured = false;
async function ensureTable() {
  if (_ensured) return;
  await control.query(`
    CREATE TABLE IF NOT EXISTS help_shots (
      name        TEXT PRIMARY KEY,
      png_bytes   BYTEA NOT NULL,
      width       INT,
      height      INT,
      caption     TEXT,
      updated_at  TIMESTAMPTZ DEFAULT now()
    )
  `);
  _ensured = true;
}

const NAME_RE = /^[a-z0-9_-]{1,80}$/;
const MAX_BYTES = 3 * 1024 * 1024;  /* 3 MB ceiling — typical 1280×800 screenshot < 600 KB */

async function expressUpload(req, res) {
  try {
    await ensureTable();
    const name = String((req.body && req.body.name) || '').trim();
    const b64  = String((req.body && req.body.b64)  || '').trim();
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'invalid name (allowed: a-z 0-9 _ -)' });
    if (!b64) return res.status(400).json({ error: 'b64 required' });
    const clean = b64.replace(/^data:image\/[a-z]+;base64,/, '');
    let buf;
    try { buf = Buffer.from(clean, 'base64'); }
    catch (_) { return res.status(400).json({ error: 'invalid base64' }); }
    if (!buf.length || buf.length > MAX_BYTES) {
      return res.status(400).json({ error: 'png size out of bounds (got ' + buf.length + ' bytes; max ' + MAX_BYTES + ')' });
    }
    const w = Number((req.body && req.body.width)  || 0) || null;
    const h = Number((req.body && req.body.height) || 0) || null;
    const cap = String((req.body && req.body.caption) || '').slice(0, 400) || null;
    await control.query(
      `INSERT INTO help_shots (name, png_bytes, width, height, caption, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (name) DO UPDATE
         SET png_bytes  = EXCLUDED.png_bytes,
             width      = EXCLUDED.width,
             height     = EXCLUDED.height,
             caption    = EXCLUDED.caption,
             updated_at = now()`,
      [name, buf, w, h, cap]
    );
    res.json({ ok: true, name, bytes: buf.length, width: w, height: h });
  } catch (e) {
    console.error('[helpShot upload]', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function expressServe(req, res) {
  try {
    await ensureTable();
    const name = String(req.params.name || '').replace(/\.png$/i, '');
    if (!NAME_RE.test(name)) return res.status(404).send('not found');
    const r = await control.query('SELECT png_bytes FROM help_shots WHERE name = $1', [name]);
    if (!r.rows[0]) return res.status(404).send('not found');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(r.rows[0].png_bytes);
  } catch (e) {
    console.error('[helpShot serve]', e.message);
    res.status(500).send('error');
  }
}

async function expressList(_req, res) {
  try {
    await ensureTable();
    const r = await control.query(
      'SELECT name, width, height, caption, octet_length(png_bytes) AS bytes, updated_at FROM help_shots ORDER BY name'
    );
    res.json({ ok: true, shots: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = { ensureTable, expressUpload, expressServe, expressList };
