// Shared auto-assign rule matcher. Used by:
//   - routes/webhooks.js (legacy /hook/website)
//   - routes/integrations.js _internalCreateLead (every /hook/leadsource source)
//   - routes/leads.js api_leads_create (manual creates without an explicit assignee)
//
// Rules match against standard lead fields (lead.source, lead.city, ...)
// AND against custom fields stored in lead.extra_json. Custom-field rules
// use the field name 'cf_<key>' — when seen, we drop the cf_ prefix and
// look up the key in extra_json (best-effort: also try lead.custom_fields
// and the raw lead object so it works regardless of where the SPA stashed
// the custom field at insert time).
//
// Round-robin: when a rule assigns to multiple users, we pick the user
// with the FEWEST leads created today — same behaviour the old inline
// matcher in webhooks.js had.
const db = require('../db/pg');

function _readField(lead, field) {
  if (!field) return '';
  // Custom field path
  if (field.startsWith('cf_')) {
    const key = field.slice(3);
    // 1. lead.extra_json (string or object)
    let extra = lead.extra_json;
    if (typeof extra === 'string') {
      try { extra = JSON.parse(extra); } catch (_) { extra = null; }
    }
    if (extra && typeof extra === 'object' && extra[key] != null) return extra[key];
    // 2. lead.custom_fields (some sources put it here)
    if (lead.custom_fields && typeof lead.custom_fields === 'object' && lead.custom_fields[key] != null) {
      return lead.custom_fields[key];
    }
    // 3. flat key on the lead
    if (lead[field] != null) return lead[field];
    if (lead[key] != null) return lead[key];
    return '';
  }
  return lead[field] != null ? lead[field] : '';
}

function _matches(operator, fieldVal, ruleVal) {
  const fv = String(fieldVal == null ? '' : fieldVal).toLowerCase().trim();
  const rv = String(ruleVal == null ? '' : ruleVal).toLowerCase().trim();
  switch (operator) {
    case 'equals':       return fv === rv;
    case 'not_equals':   return fv !== rv;
    case 'contains':     return rv ? fv.includes(rv) : false;
    case 'starts_with':  return rv ? fv.startsWith(rv) : false;
    case 'ends_with':    return rv ? fv.endsWith(rv) : false;
    case 'is_empty':     return !fv;
    case 'is_not_empty': return !!fv;
    default:             return false;
  }
}

/**
 * Decide which user a lead should be assigned to based on the tenant's
 * assignment_rules. Returns the resolved user id, or null if no rule
 * matched (caller falls back to its own default).
 *
 * @param {object} lead     the lead-shaped object (pre-insert is fine)
 * @returns {Promise<number|null>}
 */
async function pickAssigneeFromRules(lead) {
  let rules;
  try {
    rules = (await db.getAll('assignment_rules'))
      .filter(r => Number(r.is_active) === 1)
      .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
  } catch (_) { return null; }
  if (!rules.length) return null;

  for (const rule of rules) {
    const fv = _readField(lead, rule.field);
    if (!_matches(rule.operator, fv, rule.value)) continue;
    let ids = String(rule.assigned_to || '')
      .split(',').map(s => Number(s.trim())).filter(Boolean);
    if (!ids.length) continue;
    // Filter out users who are paused or deactivated. If the rule's only
    // candidate is paused, fall through to the next rule.
    try {
      const allUsers = await db.getAll('users');
      const eligible = new Set(allUsers.filter(u =>
        Number(u.is_active != null ? u.is_active : 1) === 1 &&
        u.paused_for_leads !== true && Number(u.paused_for_leads) !== 1
      ).map(u => Number(u.id)));
      ids = ids.filter(id => eligible.has(Number(id)));
    } catch (_) {}
    if (!ids.length) continue;
    if (ids.length === 1) return ids[0];
    // Round robin: fewest leads created today wins
    let counts;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const all = await db.getAll('leads');
      counts = {};
      all.forEach(l => {
        if (String(l.created_at).slice(0, 10) !== today) return;
        const k = Number(l.assigned_to) || 0;
        counts[k] = (counts[k] || 0) + 1;
      });
    } catch (_) { counts = {}; }
    ids.sort((a, b) => (counts[a] || 0) - (counts[b] || 0));
    return ids[0];
  }
  return null;
}

module.exports = { pickAssigneeFromRules, _readField, _matches };
