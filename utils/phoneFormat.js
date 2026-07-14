/* PHONE_FORMAT_v1 — 2026-07-14
 *
 * Pure functions for phone-number normalization + backfill.
 * Uses NO external deps (no libphonenumber). Handles India-heavy CRM
 * flows: 10-digit / 11-digit-with-0 / 12-digit-with-CC / E.164 inputs.
 *
 * Rule shape (JSONB stored per source in lead_source_mapping.phone_format):
 *   {
 *     source_format: 'auto' | 'e164' | 'cc_noplus' | 'local' | 'raw',
 *     store_format:  'raw' | 'e164' | 'cc_noplus' | 'local',
 *     default_cc:    'IN' | 'US' | 'UK' | 'AE' | 'SG' | 'AU' | ...  (ISO-2)
 *     apply_to_wa:   true|false      apply same rule to leads.whatsapp
 *     reject_invalid:true|false      hard-reject at webhook if invalid
 *     dedupe_on_phone:true|false     look up existing lead by normalized phone
 *   }
 */
'use strict';

/* ISO-2 → dial code table (extend as needed) */
const CC = {
  IN: '91', US: '1', UK: '44', AE: '971', SG: '65', AU: '61',
  CA: '1', DE: '49', FR: '33', SA: '966', BD: '880', PK: '92',
  NP: '977', LK: '94', MY: '60', TH: '66', ID: '62', PH: '63',
  NZ: '64', ZA: '27', KE: '254'
};
const DEFAULT_CC_ISO = 'IN';

/* Expected local-mobile length per country (used for validation). */
const LOCAL_LEN = { IN: 10, US: 10, UK: 10, AE: 9, SG: 8, AU: 9, BD: 10, PK: 10, LK: 9, MY: 9, TH: 9, ID: 10, PH: 10 };

function _digits(s) { return String(s == null ? '' : s).replace(/\D+/g, ''); }
function _cc(iso) { return CC[String(iso || DEFAULT_CC_ISO).toUpperCase()] || CC[DEFAULT_CC_ISO]; }
function _localLen(iso) { return LOCAL_LEN[String(iso || DEFAULT_CC_ISO).toUpperCase()] || 10; }

/* Given a raw string + hints, return { cc, local, valid }.
 * - source_format hint helps disambiguate (e.g. treat 12-digit as US-with-CC vs India-with-CC)
 * - default_cc is the fallback country code if no CC present.
 */
function parsePhone(raw, opts) {
  opts = opts || {};
  const src = String(opts.source_format || 'auto').toLowerCase();
  const iso = String(opts.default_cc || DEFAULT_CC_ISO).toUpperCase();
  const cc  = _cc(iso);
  const wantLocal = _localLen(iso);
  const hadPlus = /^\s*\+/.test(String(raw || ''));
  const d = _digits(raw);
  if (!d) return { cc: '', local: '', valid: false, raw: String(raw || '') };

  /* Explicit E.164 (had +) → strip default_cc if it prefixes, else take remainder */
  if (hadPlus || src === 'e164') {
    if (d.startsWith(cc) && d.length === cc.length + wantLocal) {
      return { cc, local: d.slice(cc.length), valid: true, raw };
    }
    /* try any known cc prefix */
    for (const k of Object.keys(CC)) {
      const p = CC[k];
      if (d.startsWith(p) && d.length === p.length + _localLen(k)) {
        return { cc: p, local: d.slice(p.length), valid: true, raw };
      }
    }
    return { cc: '', local: d, valid: false, raw };
  }

  /* 12-digit starting with country code (IndiaMart / Meta variant) */
  if (src === 'cc_noplus' || (src === 'auto' && d.startsWith(cc) && d.length === cc.length + wantLocal)) {
    return { cc, local: d.slice(cc.length), valid: d.length === cc.length + wantLocal, raw };
  }

  /* 11-digit starting with 0 → STD dialling within India, strip 0 */
  if (d.length === wantLocal + 1 && d.startsWith('0')) {
    return { cc, local: d.slice(1), valid: true, raw };
  }

  /* Pure local (10-digit India) */
  if (src === 'local' || d.length === wantLocal) {
    return { cc, local: d, valid: d.length === wantLocal, raw };
  }

  /* Fallback: assume prefix is CC */
  if (d.length > wantLocal) {
    return { cc: d.slice(0, d.length - wantLocal), local: d.slice(-wantLocal), valid: false, raw };
  }
  return { cc: '', local: d, valid: false, raw };
}

/* Format the parsed phone per store_format. */
function formatPhone(parsed, storeFormat) {
  if (!parsed || !parsed.local) return '';
  const f = String(storeFormat || 'raw').toLowerCase();
  if (f === 'raw')       return parsed.raw || (parsed.cc ? parsed.cc + parsed.local : parsed.local);
  if (f === 'local')     return parsed.local;
  if (f === 'cc_noplus') return (parsed.cc || '') + parsed.local;
  if (f === 'e164')      return '+' + (parsed.cc || '') + parsed.local;
  return parsed.local;
}

/* One-shot normalizer used at webhook ingestion.
 * Returns { value, parsed, valid, changed } where value is the string to store. */
function normalizePhone(raw, rule) {
  rule = rule || {};
  const p = parsePhone(raw, rule);
  const store = rule.store_format || 'raw';
  const value = formatPhone(p, store);
  return { value, parsed: p, valid: p.valid, changed: value !== String(raw || '') };
}

/* Backfill helper — for a batch of {id, phone} rows and a rule, return
 * before/after previews + a list of would-be duplicates. */
function backfillPreview(rows, rule) {
  const seen = {};
  const preview = [];
  const dupes = [];
  (rows || []).forEach(r => {
    const parsed = parsePhone(r.phone, rule);
    const nv = formatPhone(parsed, rule.store_format);
    preview.push({ id: r.id, name: r.name || '', before: r.phone || '', after: nv, valid: parsed.valid, changed: nv !== String(r.phone || '') });
    if (nv) {
      if (seen[nv]) dupes.push({ id: r.id, other_id: seen[nv], normalized: nv });
      else seen[nv] = r.id;
    }
  });
  return {
    total: preview.length,
    changed: preview.filter(x => x.changed).length,
    invalid: preview.filter(x => !x.valid).length,
    dupes,
    preview
  };
}

module.exports = { parsePhone, formatPhone, normalizePhone, backfillPreview, CC, LOCAL_LEN };
