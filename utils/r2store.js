/**
 * R2_STORE_v1 — general-purpose Cloudflare R2 storage for tenant files
 * (ticket attachments, storefront/catalogue media, financial docs, KB files…).
 *
 * SEPARATE from utils/r2.js on purpose. utils/r2.js is the LOCKED recordings
 * helper and owns R2_BUCKET (= smartcrm-recordings). This module NEVER touches
 * that variable — it uses its own bucket vars so the two systems can't collide.
 *
 * NON-DESTRUCTIVE BY DESIGN: this module only ever PUTs and GETs. It exposes no
 * delete. Callers keep the existing Postgres BYTEA as the source of truth and
 * treat R2 as a zero-egress serving layer. Nothing here removes data.
 *
 * Rollout lever — R2_OFFLOAD:
 *   'off'   (default) → do nothing. writesEnabled()=false, readsEnabled()=false.
 *                       App behaves exactly as before (pure BYTEA).
 *   'write'           → dual-write: new uploads also go to R2 and set r2_key,
 *                       but downloads still stream BYTEA. Safe warm-up while a
 *                       backfill runs. readsEnabled()=false.
 *   'on'              → serve from R2 when an r2_key exists (BYTEA fallback when
 *                       it doesn't). Full zero-egress mode.
 * Flip 'on' → 'off' at any time to instantly roll back with zero data loss.
 *
 * Env vars (Railway):
 *   R2_ENDPOINT           reused from recordings — account S3 endpoint, no bucket suffix
 *   R2_ACCESS_KEY_ID      reused — must have access to the buckets below
 *   R2_SECRET_ACCESS_KEY  reused
 *   R2_PRIVATE_BUCKET     smartcrm-saas          (recordings/attachments/whatsapp/receipts/imports)
 *   R2_PUBLIC_BUCKET      smartcrm-saas-public   (store/branding — public CDN)
 *   R2_PUBLIC_BASE_URL    https://pub-...r2.dev  (or a custom domain)
 *   R2_OFFLOAD            off | write | on       (default off)
 */
'use strict';

let _client = null;

const CATEGORIES = {
  attachments: { public: false },
  kb:          { public: false },
  catalogue:   { public: false },
  whatsapp:    { public: false },
  receipts:    { public: false },
  imports:     { public: false },
  store:       { public: true },
  branding:    { public: true },
};

function _cfg() {
  return {
    endpoint:      process.env.R2_ENDPOINT || '',
    ak:            process.env.R2_ACCESS_KEY_ID || '',
    sk:            process.env.R2_SECRET_ACCESS_KEY || '',
    privateBucket: process.env.R2_PRIVATE_BUCKET || '',
    publicBucket:  process.env.R2_PUBLIC_BUCKET || '',
    publicBase:    (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    mode:          (process.env.R2_OFFLOAD || 'off').toLowerCase(),
  };
}

function isConfigured() {
  const c = _cfg();
  return !!(c.endpoint && c.ak && c.sk && c.privateBucket);
}
function mode() { return _cfg().mode; }
function writesEnabled() { return isConfigured() && (mode() === 'write' || mode() === 'on'); }
function readsEnabled()  { return isConfigured() && mode() === 'on'; }

function _isPublic(category) {
  const cat = CATEGORIES[category];
  if (!cat) throw new Error('r2store: unknown category "' + category + '"');
  return cat.public;
}
function _bucketFor(category) {
  const c = _cfg();
  return _isPublic(category) ? (c.publicBucket || c.privateBucket) : c.privateBucket;
}
function _sanitize(p) {
  return String(p == null ? '' : p).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
}

/** tenants/<slug>/<category>/<subPath...>/<filename> */
function buildKey({ tenant, category, filename, subPath }) {
  if (!CATEGORIES[category]) throw new Error('r2store: unknown category "' + category + '"');
  const parts = ['tenants', _sanitize(tenant || 'unknown'), category];
  if (subPath) String(subPath).split('/').filter(Boolean).forEach(p => parts.push(_sanitize(p)));
  parts.push(_sanitize(filename || 'file'));
  return parts.join('/');
}

function _s3() {
  if (_client) return _client;
  const c = _cfg();
  const { S3Client } = require('@aws-sdk/client-s3');
  _client = new S3Client({
    region: 'auto',
    endpoint: c.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: c.ak, secretAccessKey: c.sk },
  });
  return _client;
}

/** Upload bytes for a category. Returns the object key. */
async function put({ tenant, category, filename, subPath, body, contentType, key }) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const k = key || buildKey({ tenant, category, filename, subPath });
  const opts = {
    Bucket: _bucketFor(category), Key: k, Body: body,
    ContentType: contentType || 'application/octet-stream',
  };
  if (_isPublic(category)) opts.CacheControl = 'public, max-age=31536000, immutable';
  await _s3().send(new PutObjectCommand(opts));
  return k;
}

/** Short-lived signed GET URL for a private object. */
async function presignGet(key, category, expiresSec) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(_s3(), new GetObjectCommand({ Bucket: _bucketFor(category), Key: key }),
    { expiresIn: Math.max(30, Number(expiresSec) || 900) });
}

/** Public CDN URL for a public-category object. */
function publicUrl(key) {
  const c = _cfg();
  if (!c.publicBase) throw new Error('r2store: R2_PUBLIC_BASE_URL not set');
  return c.publicBase + '/' + key;
}

/** Correct browser URL for any stored object. */
async function urlFor(key, category, expiresSec) {
  return _isPublic(category) ? publicUrl(key) : presignGet(key, category, expiresSec);
}

/** Fetch bytes back (used by backfill verification). */
async function getBuffer(key, category) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const r = await _s3().send(new GetObjectCommand({ Bucket: _bucketFor(category), Key: key }));
  const chunks = [];
  for await (const ch of r.Body) chunks.push(ch);
  return Buffer.concat(chunks);
}

module.exports = {
  CATEGORIES, isConfigured, mode, writesEnabled, readsEnabled,
  buildKey, put, presignGet, publicUrl, urlFor, getBuffer, _cfg,
};
