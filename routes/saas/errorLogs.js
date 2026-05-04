/**
 * Central error log — the user's "I don't want any errors in logs" request.
 *
 * Two surfaces:
 *   1. logError({...}) — fire-and-forget writer used by:
 *        • the Express error middleware in server.js
 *        • the public POST /api/saas/log-error endpoint (frontend)
 *        • any explicit catch block that wants to record a problem
 *      Dedupes by fingerprint (source + first stack line). Same error
 *      twice in a row bumps occurrences/last_seen_at instead of creating
 *      a new row.
 *
 *   2. Super-admin API (api_saas_errorLogs_*) — list / get / resolve /
 *      delete. Backs the /admin → Errors page where an operator can
 *      triage and clear the queue.
 */
const crypto = require('crypto');
const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');

/** Truncate to keep individual rows from blowing up Postgres TOAST. */
function _trim(s, max) {
  if (s == null) return null;
  const str = typeof s === 'string' ? s : String(s);
  return str.length > max ? str.slice(0, max) : str;
}

function _fingerprint(source, stack, message) {
  const firstStackLine = String(stack || '').split('\n').find(l => l.trim()) || '';
  const seed = (source || '') + '|' + (firstStackLine || message || '');
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

/**
 * Write an error row. Never throws — if the control DB is down we just
 * console.error and move on; the original request shouldn't fail just
 * because logging did.
 *
 * Accepts: { source, severity, message, stack, url, method, status_code,
 *            ua, user_id, user_email, tenant_slug, context }
 */
async function logError(input) {
  try {
    const i = input || {};
    const source   = String(i.source || 'server').slice(0, 64);
    const severity = String(i.severity || 'error').slice(0, 16);
    const message  = _trim(i.message || '(no message)', 4000);
    const stack    = _trim(i.stack, 16000);
    const url      = _trim(i.url, 1000);
    const method   = _trim(i.method, 16);
    const ua       = _trim(i.ua, 500);
    const userEmail = _trim(i.user_email, 200);
    const tenantSlug = _trim(i.tenant_slug, 80);
    const fp = _fingerprint(source, stack, message);

    // Try to bump an existing same-fingerprint row first; if no row was
    // updated, insert a fresh one. We don't use ON CONFLICT here because
    // fingerprint is not UNIQUE — leaving it non-unique keeps inserts
    // cheap when no dedupe row exists.
    const r = await control.query(
      `UPDATE error_logs
          SET occurrences = occurrences + 1,
              last_seen_at = NOW(),
              -- always carry forward the latest message/stack so the
              -- admin sees the most recent flavour of the bug
              message = $2,
              stack   = COALESCE($3, stack),
              url     = COALESCE($4, url),
              context = COALESCE($5, context)
        WHERE fingerprint = $1 AND resolved = 0
        RETURNING id`,
      [fp, message, stack, url, i.context ? JSON.stringify(i.context) : null]
    );
    if (r.rowCount > 0) return r.rows[0].id;

    return await control.insert('error_logs', {
      source, severity, message, stack, url, method,
      status_code: i.status_code || null,
      ua, user_id: i.user_id || null, user_email: userEmail,
      tenant_slug: tenantSlug,
      fingerprint: fp,
      context: i.context ? JSON.stringify(i.context) : null
    });
  } catch (e) {
    // Last-resort — never let logging blow up the calling code.
    console.error('[error-log] failed to record:', e.message);
  }
}

/* ---------- Express middleware -----------------------------------
 * Mount AFTER all routes. Catches anything that throws/rejects in a
 * route handler and persists it before passing through to the default
 * Express handler so the user still sees a 500. */
function expressErrorMiddleware(err, req, res, _next) {
  // Best-effort: don't block the response on the DB write
  logError({
    source: 'server',
    severity: 'error',
    message: err && err.message ? err.message : String(err),
    stack:   err && err.stack ? err.stack : null,
    url:     req.originalUrl || req.url,
    method:  req.method,
    status_code: err.status || 500,
    ua:      req.get && req.get('user-agent'),
    tenant_slug: req.tenantSlug || (req.tenant && req.tenant.slug) || null,
    context: {
      query: req.query,
      // Don't log password fields if they slip through
      body:  _redact(req.body)
    }
  }).catch(() => {});
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
}
function _redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (/password|secret|token|api_?key/i.test(k)) out[k] = '[redacted]';
    else out[k] = obj[k];
  }
  return out;
}

/* ---------- Public client-error endpoint -------------------------
 * Mount as: app.post('/api/saas/log-error', expressClientErrorEndpoint)
 * Takes a JSON body from the browser's window.error / unhandledrejection
 * handlers. No auth — the body is treated as untrusted, so we cap
 * sizes and don't trust any field that could be used to escalate. */
function expressClientErrorEndpoint(req, res) {
  const b = req.body || {};
  logError({
    source: String(b.source || 'client').slice(0, 64),
    severity: 'error',
    message: b.message || '(no message)',
    stack:   b.stack,
    url:     b.url,
    ua:      b.ua || (req.get && req.get('user-agent')),
    tenant_slug: req.tenantSlug || null,
    context: {
      file: b.file, line: b.line, col: b.col,
      ts_iso: b.ts_iso
    }
  }).catch(() => {});
  res.json({ ok: true });
}

/* ---------- Super-admin API --------------------------------------- */
async function api_saas_errorLogs_list(token, filters) {
  await requireSuperAdmin(token);
  const f = filters || {};
  const where = []; const params = [];
  // Default to "still open" so admins always see their queue first.
  if (f.resolved === '1' || f.resolved === 1) {
    where.push('resolved = 1');
  } else if (f.resolved === 'all') {
    // no-op
  } else {
    where.push('resolved = 0');
  }
  if (f.source)   { params.push(f.source);   where.push(`source = $${params.length}`); }
  if (f.severity) { params.push(f.severity); where.push(`severity = $${params.length}`); }
  if (f.q) {
    params.push('%' + String(f.q).toLowerCase() + '%');
    where.push(`(LOWER(message) LIKE $${params.length} OR LOWER(url) LIKE $${params.length})`);
  }
  const sql = `
    SELECT id, source, severity, message, url, method, status_code,
           tenant_slug, user_email, occurrences,
           first_seen_at, last_seen_at, resolved
      FROM error_logs
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY last_seen_at DESC
     LIMIT 500`;
  const r = await control.query(sql, params);

  // Counts for the header chips
  const counts = await control.query(
    `SELECT
       COUNT(*) FILTER (WHERE resolved = 0)   AS open_count,
       COUNT(*) FILTER (WHERE resolved = 1)   AS resolved_count,
       COUNT(*) FILTER (WHERE resolved = 0 AND last_seen_at > NOW() - INTERVAL '24 hours') AS open_24h
       FROM error_logs`
  );
  return { rows: r.rows, counts: counts.rows[0] || {} };
}

async function api_saas_errorLogs_get(token, id) {
  await requireSuperAdmin(token);
  return control.findById('error_logs', id);
}

async function api_saas_errorLogs_resolve(token, id, note) {
  const sa = await requireSuperAdmin(token);
  await control.query(
    `UPDATE error_logs
        SET resolved = 1,
            resolved_at = NOW(),
            resolved_by = $2,
            resolution_note = $3
      WHERE id = $1`,
    [id, sa.id, note ? String(note).slice(0, 1000) : null]
  );
  return { ok: true };
}

async function api_saas_errorLogs_resolveAll(token, filters) {
  const sa = await requireSuperAdmin(token);
  const f = filters || {};
  const where = ['resolved = 0']; const params = [sa.id];
  if (f.source)   { params.push(f.source);   where.push(`source = $${params.length}`); }
  if (f.fingerprint) { params.push(f.fingerprint); where.push(`fingerprint = $${params.length}`); }
  const r = await control.query(
    `UPDATE error_logs
        SET resolved = 1, resolved_at = NOW(), resolved_by = $1
      WHERE ${where.join(' AND ')}`,
    params
  );
  return { ok: true, marked: r.rowCount };
}

async function api_saas_errorLogs_reopen(token, id) {
  await requireSuperAdmin(token);
  await control.query(
    `UPDATE error_logs
        SET resolved = 0, resolved_at = NULL, resolved_by = NULL, resolution_note = NULL
      WHERE id = $1`,
    [id]
  );
  return { ok: true };
}

async function api_saas_errorLogs_delete(token, id) {
  await requireSuperAdmin(token);
  await control.query(`DELETE FROM error_logs WHERE id = $1`, [id]);
  return { ok: true };
}

async function api_saas_errorLogs_purgeResolved(token) {
  await requireSuperAdmin(token);
  const r = await control.query(`DELETE FROM error_logs WHERE resolved = 1`);
  return { ok: true, deleted: r.rowCount };
}

module.exports = {
  // helpers
  logError,
  expressErrorMiddleware,
  expressClientErrorEndpoint,
  // admin API
  api_saas_errorLogs_list,
  api_saas_errorLogs_get,
  api_saas_errorLogs_resolve,
  api_saas_errorLogs_resolveAll,
  api_saas_errorLogs_reopen,
  api_saas_errorLogs_delete,
  api_saas_errorLogs_purgeResolved
};
