/**
 * utils/aiCrypto.js
 *
 * Tiny AES-256-GCM wrapper used to encrypt the Gemini API key (and any
 * future SaaS-owner secrets) before writing to the control DB.
 *
 * Why bother encrypting if Postgres encrypts data at rest on Railway?
 * Defence in depth — a leaked DB dump (or a careless `pg_dump` shared
 * for debugging) doesn't immediately leak the platform's Google billing
 * key. The key in Postgres is just ciphertext; you also need
 * AI_SECRET_KEY (env var) to read it.
 *
 * AI_SECRET_KEY must be a 32-byte secret encoded as either:
 *   - 64 hex characters
 *   - 44 base64 characters
 * If unset, we deterministically derive one from JWT_SECRET so deploys
 * keep working out of the box. (The first save then ties the encryption
 * to that derived key — rotating JWT_SECRET would orphan stored keys
 * and the super-admin has to re-paste the Gemini key. That's fine —
 * JWT_SECRET rotations are infrequent and require a re-deploy anyway.)
 */

'use strict';

const crypto = require('crypto');

let _cachedKey = null;
function _getKey() {
  if (_cachedKey) return _cachedKey;
  const raw = process.env.AI_SECRET_KEY || '';
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      _cachedKey = Buffer.from(raw, 'hex');
      return _cachedKey;
    }
    try {
      const buf = Buffer.from(raw, 'base64');
      if (buf.length === 32) { _cachedKey = buf; return _cachedKey; }
    } catch (_) {}
  }
  // Fallback: derive from JWT_SECRET. Stable across restarts as long as
  // the env var doesn't change.
  const seed = process.env.JWT_SECRET || process.env.SECRET_KEY || 'smartcrm-saas-default-secret';
  _cachedKey = crypto.createHash('sha256').update(seed + ':ai-key-v1').digest();
  return _cachedKey;
}

/**
 * Encrypt a UTF-8 string. Returns a single base64 envelope of:
 *   <iv:12 bytes><ciphertext:N bytes><authTag:16 bytes>
 * Versioned with a leading 'v1:' prefix so we can rotate algorithms later.
 *
 * Empty / null input returns null (so the column stays NULL).
 */
function encryptString(plain) {
  if (plain == null || plain === '') return null;
  const iv  = crypto.randomBytes(12);
  const key = _getKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, ct, tag]).toString('base64');
}

/**
 * Decrypt the envelope produced by encryptString. Returns '' on null /
 * malformed input rather than throwing — the caller treats empty as
 * "not configured".
 */
function decryptString(envelope) {
  if (!envelope) return '';
  try {
    const s = String(envelope);
    if (!s.startsWith('v1:')) return '';
    const buf = Buffer.from(s.slice(3), 'base64');
    if (buf.length < 12 + 16 + 1) return '';
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(buf.length - 16);
    const ct  = buf.slice(12, buf.length - 16);
    const key = _getKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    // Most likely AI_SECRET_KEY changed — treat as not configured rather
    // than crash the route.
    console.warn('[aiCrypto] decrypt failed:', e.message);
    return '';
  }
}

/**
 * Mask a key for display: keep first 4 + last 4 characters.
 */
function maskKey(plain) {
  if (!plain) return '';
  const s = String(plain);
  if (s.length <= 10) return '••••';
  return s.slice(0, 4) + '••••' + s.slice(-4);
}

module.exports = { encryptString, decryptString, maskKey };
