/* PHONE_91_PREFIX_v1 — 2026-07-14
 *
 * Ultra-simple normalizer for the tenant-wide "+91 Prefix" toggle:
 *   Strip everything non-digit, take last 10 digits, prefix "+91".
 *
 * If the input has fewer than 10 digits, or is empty, return the ORIGINAL
 * input unchanged (safer than mangling short garbage into "+91").
 *
 * Examples:
 *   "+91 8787878787"     -> "+918787878787"
 *   "91 98-98-89-89-23"  -> "+919898898923"
 *   "9898989898"         -> "+919898989898"
 *   "09802930495"        -> "+919802930495"
 *   ""                   -> ""
 *   "abc"                -> "abc" (unchanged, no digits)
 *   "12345"              -> "12345" (unchanged, <10 digits)
 */
'use strict';

function normalize91(raw) {
  if (raw == null) return raw;
  const s = String(raw);
  const digits = s.replace(/\D+/g, '');
  if (!digits || digits.length < 10) return s;
  return '+91' + digits.slice(-10);
}

/* Async check for the tenant config toggle. Cached per-request via the
 * tenantStorage pool is not necessary here — getConfig is cheap. */
async function isEnabled(db) {
  try {
    const v = await db.getConfig('PHONE_91_PREFIX_ENABLED', '0');
    return String(v) === '1';
  } catch (_) { return false; }
}

/* Apply normalization to a payload IN-PLACE if the toggle is on.
 * Touches phone + whatsapp + alt_phone. Safe to call unconditionally. */
async function applyIfEnabled(db, payload) {
  try {
    if (!(await isEnabled(db))) return payload;
    ['phone', 'whatsapp', 'alt_phone', 'mobile', 'contact', 'contact_number', 'mobile_number'].forEach(k => {
      if (payload && payload[k]) {
        const v = normalize91(payload[k]);
        if (v !== payload[k]) payload[k] = v;
      }
    });
    return payload;
  } catch (_) { return payload; }
}

module.exports = { normalize91, isEnabled, applyIfEnabled };
