/**
 * utils/totp.js — RFC 6238 Time-Based One-Time Passwords using only
 * Node's built-in `crypto`. Compatible with Google Authenticator, Authy,
 * 1Password, Microsoft Authenticator — anything that consumes the
 * standard `otpauth://totp/...` provisioning URL.
 *
 * - 30-second window, 6-digit code, HMAC-SHA1 (the Authenticator default)
 * - Verify accepts ±1 step of clock drift (so a code that just rolled
 *   over still authenticates for ~30s after expiry)
 *
 * Why hand-rolled instead of `speakeasy`?
 *   1. Adding an npm dep means a Railway redeploy + npm install round-trip
 *      every tenant. RFC 6238 is ~50 lines.
 *   2. Fewer transitive deps = smaller attack surface for an auth path.
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function _base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function _base32Decode(str) {
  const clean = String(str || '').replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0;
  const bytes = [];
  for (const c of clean) {
    const idx = ALPHABET.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generate a fresh base32 secret. 20 random bytes → 32-character base32
 * string, the canonical Google Authenticator length.
 */
function generateSecret() {
  return _base32Encode(crypto.randomBytes(20));
}

/**
 * Compute the 6-digit TOTP for a given step (default: current 30s window).
 * Internal — exported only for tests / verify().
 */
function _hotp(secretBase32, step) {
  const key = _base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  // Big-endian 64-bit step. JS bitwise is 32-bit so split high/low halves.
  buf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  buf.writeUInt32BE(step >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
             | ((hmac[offset + 1] & 0xff) << 16)
             | ((hmac[offset + 2] & 0xff) << 8)
             | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function generate(secretBase32) {
  const step = Math.floor(Date.now() / 30000);
  return _hotp(secretBase32, step);
}

/**
 * Verify a user-entered OTP against the secret with ±drift steps of
 * tolerance (default: 1 step = ±30s). Returns true on first match.
 */
function verify(secretBase32, otp, drift = 1) {
  const clean = String(otp || '').replace(/\D/g, '').padStart(6, '0').slice(-6);
  if (clean.length !== 6) return false;
  const step = Math.floor(Date.now() / 30000);
  for (let i = -drift; i <= drift; i++) {
    if (_hotp(secretBase32, step + i) === clean) return true;
  }
  return false;
}

/**
 * Build the otpauth:// URL the authenticator app reads from a QR code.
 *   account: e.g. "alice@stockbox.com"
 *   issuer:  brand name shown in the authenticator list, e.g. "Stockbox CRM"
 */
function buildOtpauthUrl(secretBase32, account, issuer) {
  const enc = encodeURIComponent;
  const label = enc(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30'
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, generate, verify, buildOtpauthUrl };
