const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

function _parseExtra(lead) {
  if (!lead) return {};
  try {
    const raw = lead.extra_json;
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    return JSON.parse(String(raw));
  } catch (_) { return {}; }
}

async function _lookups() {
  const [usersArr, statusesArr, productsArr, tatRows] = await Promise.all([
    db.getAll('users'),
    db.getAll('statuses'),
    db.getAll('products'),
    // tat_thresholds may not exist on very old installs — degrade gracefully
    db.getAll('tat_thresholds').catch(() => [])
  ]);
  const usersById = {}, statusesById = {}, productsById = {};
  usersArr.forEach(u => { usersById[Number(u.id)] = u; });
  statusesArr.forEach(s => { statusesById[Number(s.id)] = s; });
  productsArr.forEach(p => { productsById[Number(p.id)] = p; });
  // Per-status TAT threshold (minutes). Only active rows count — admin
  // can flip is_active=0 in Settings → TAT to suspend tracking on a stage
  // without losing the configured value.
  const tatByStatusId = {};
  (tatRows || []).forEach(t => {
    if (Number(t.is_active) === 1) {
      tatByStatusId[Number(t.status_id)] = Number(t.threshold_minutes);
    }
  });
  // Final stages (Won/Lost/etc.) are exempt from violation highlighting —
  // a lead sitting in a closed-out stage shouldn't keep flashing red.
  const finalStatusIds = new Set(
    statusesArr.filter(s => Number(s.is_final) === 1).map(s => Number(s.id))
  );
  return { usersById, statusesById, productsById, tatByStatusId, finalStatusIds };
}

function _hydrate(l, usersById, statusesById, productsById, tatByStatusId, finalStatusIds) {
  const u = usersById[Number(l.assigned_to)];
  const s = statusesById[Number(l.status_id)];
  const p = productsById[Number(l.product_id)];
  const out = Object.assign({}, l, {
    assigned_name: u ? u.name : '',
    status_name: s ? s.name : '',
    status_color: s ? s.color : '#6b7280',
    product_name: p ? p.name : '',
    extra: _parseExtra(l)
  });
  // TAT-violation flag: lead has been in its current status longer than
  // the configured threshold (without progressing). Computed on hydrate
  // so the Leads grid + New-leads tab can highlight breached rows
  // without an extra round-trip. Final stages are exempt.
  out.tat_violation = false;
  out.tat_threshold_minutes = null;
  out.tat_minutes_over = null;
  if (tatByStatusId && finalStatusIds) {
    const sid = Number(l.status_id) || 0;
    const limit = tatByStatusId[sid];
    if (limit && !finalStatusIds.has(sid)) {
      const enteredAt = l.last_status_change_at || l.created_at;
      if (enteredAt) {
        const ageMin = (Date.now() - new Date(enteredAt).getTime()) / 60_000;
        out.tat_threshold_minutes = limit;
        if (ageMin >= limit) {
          out.tat_violation = true;
          out.tat_minutes_over = Math.max(0, Math.round(ageMin - limit));
        }
      }
    }
  }
  return out;
}

function _isVisible(me, visible, lead) {
  if (me.role === 'admin') return true;
  if (!lead.assigned_to) return false;
  return visible.includes(Number(lead.assigned_to));
}

// Duplicate detection
async function _findDuplicate(payload) {
  const policy = process.env.DUPLICATE_POLICY || 'allow';
  if (policy === 'allow') return null;
  const hours = Number(process.env.DUPLICATE_WINDOW_HOURS) || 24;
  const fields = String(process.env.DUPLICATE_MATCH_FIELDS || 'phone,email')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!hours || !fields.length) return null;

  const phone = String(payload.phone || '').replace(/\D/g, '');
  const email = String(payload.email || '').trim().toLowerCase();
  const wa    = String(payload.whatsapp || '').replace(/\D/g, '');
  if (!phone && !email && !wa) return null;

  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const leads = (await db.getAll('leads')).filter(l => String(l.created_at) >= since);
  for (const l of leads) {
    const lp = String(l.phone || '').replace(/\D/g, '');
    const lw = String(l.whatsapp || '').replace(/\D/g, '');
    const le = String(l.email || '').trim().toLowerCase();
    if (fields.includes('phone')) {
      if (phone && (phone === lp || phone === lw)) return l;
      if (wa && (wa === lp || wa === lw)) return l;
    }
    if (fields.includes('email')) {
      if (email && email === le) return l;
    }
  }
  return null;
}

async function _applyDuplicatePolicy(payload, fallbackUserId) {
  const match = await _findDuplicate(payload);
  if (!match) return { payload, duplicate: false, matched_id: null };
  const policy = process.env.DUPLICATE_POLICY || 'allow';
  const out = Object.assign({}, payload);
  if (policy === 'reject') {
    const err = new Error('DUPLICATE: matched existing lead id ' + match.id);
    err.matched_id = match.id;
    throw err;
  }
  if (policy === 'assign_same_user') {
    out.assigned_to = match.assigned_to || fallbackUserId || '';
  } else if (policy === 'skip_assignment') {
    out.assigned_to = '';
  }
  return { payload: out, duplicate: true, matched_id: match.id, matched_assigned_to: match.assigned_to || '' };
}

/**
 * Lead cap check — returns whether `userId` can accept one more lead
 * today / this month based on their daily_lead_cap and monthly_lead_cap
 * settings. Admin manual assignments bypass via the `forceBypass` arg.
 *
 *   { ok: true }  → safe to assign
 *   { ok: false, reason: '...', daily_used, daily_cap, ... } → at cap
 *
 * Cap = 0 means "no cap" — the more common default.
 */
async function _canAssignToUser(userId, forceBypass) {
  if (forceBypass) return { ok: true };
  if (!userId) return { ok: true };
  const user = await db.findById('users', userId).catch(() => null);
  if (!user) return { ok: true };
  const dailyCap = Number(user.daily_lead_cap) || 0;
  const monthlyCap = Number(user.monthly_lead_cap) || 0;
  if (dailyCap <= 0 && monthlyCap <= 0) return { ok: true };

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const myLeads = (await db.getAll('leads')).filter(l => Number(l.assigned_to) === Number(userId));

  if (dailyCap > 0) {
    const todayCount = myLeads.filter(l => String(l.created_at).slice(0, 10) === today).length;
    if (todayCount >= dailyCap) {
      return { ok: false, reason: `daily cap reached (${todayCount}/${dailyCap})`,
               daily_used: todayCount, daily_cap: dailyCap };
    }
  }
  if (monthlyCap > 0) {
    const monthCount = myLeads.filter(l => String(l.created_at).slice(0, 7) === month).length;
    if (monthCount >= monthlyCap) {
      return { ok: false, reason: `monthly cap reached (${monthCount}/${monthlyCap})`,
               monthly_used: monthCount, monthly_cap: monthlyCap };
    }
  }
  return { ok: true };
}

/**
 * Pick the next user from a candidate pool who is NOT at cap. Used by
 * round-robin / percent assignment loops. Falls back to null if every
 * candidate is capped (caller decides what to do — usually leaves the
 * lead unassigned and surfaces it for admin review).
 */
async function _pickUncappedUser(candidateIds, startIdx) {
  const total = candidateIds.length;
  if (!total) return null;
  for (let i = 0; i < total; i++) {
    const idx = (startIdx + i) % total;
    const uid = Number(candidateIds[idx]);
    const r = await _canAssignToUser(uid, false);
    if (r.ok) return uid;
  }
  return null;
}

async function _newStatusId() {
  const s = await db.findOneBy('statuses', 'name', 'New');
  return s ? s.id : '';
}

/**
 * Resolve the 'Pending' status id — used as the starting status for any
 * newly-created lead that's been flagged as a duplicate. We don't carry
 * the original's status over to the duplicate row because the duplicate
 * is conceptually a fresh enquiry that needs review. Auto-creates the
 * status if a 'Pending' row doesn't exist yet.
 */
async function _pendingStatusId() {
  const all = await db.getAll('statuses');
  const found = all.find(s => /^pending$/i.test(String(s.name || '').trim()));
  if (found) return found.id;
  const id = await db.insert('statuses', {
    name: 'Pending', color: '#94a3b8', sort_order: 5, is_final: 0
  });
  return id;
}

/**
 * Resolve the 'Junk' status id. Matches 'Junk', 'Junk Lead', 'Spam'
 * case-insensitively, then auto-creates 'Junk' if no matching status
 * exists yet — so the rule keeps working even on fresh databases.
 */
async function _junkStatusId() {
  const all = await db.getAll('statuses');
  const found = all.find(s => /^(junk|junk\s+lead|spam)$/i.test(String(s.name || '')));
  if (found) return found.id;
  // Auto-create
  const id = await db.insert('statuses', {
    name: 'Junk', color: '#64748b', sort_order: 990, is_final: 1
  });
  return id;
}

/**
 * Resolve a status NAME (e.g. "Follow Up", "Converted") to a status_id.
 * Case-insensitive, trims whitespace. Auto-creates the status if it doesn't
 * exist yet — that way bulk CSV imports just work even when the spreadsheet
 * has status values the admin hasn't pre-defined.
 *
 * Pass an empty/falsy raw to fall back to the default "New" status.
 */
/**
 * Parse a date string from a CSV cell into ISO. Accepts ISO 8601,
 * "YYYY-MM-DD HH:MM", "DD/MM/YYYY", and several common variants.
 * Returns the original input if it's already a Date or if parsing
 * fails (so the DB layer can decide). Returns "" for blank.
 */
function _parseDate(raw) {
  if (raw == null || raw === '') return '';
  if (raw instanceof Date && !isNaN(raw)) return raw.toISOString();
  const s = String(raw).trim();
  if (!s) return '';
  // Already ISO-ish
  let d = new Date(s);
  if (!isNaN(d)) return d.toISOString();
  // DD/MM/YYYY or DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    const year = yyyy.length === 2 ? '20' + yyyy : yyyy;
    d = new Date(`${year}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T${(hh||'00').padStart(2,'0')}:${mi||'00'}:${ss||'00'}`);
    if (!isNaN(d)) return d.toISOString();
  }
  // Last resort — return input so the DB rejects it loudly rather than
  // silently corrupting the row.
  return s;
}

async function _resolveStatusIdByName(raw) {
  const name = String(raw || '').trim();
  if (!name) return await _newStatusId();
  // Already an integer ID? Trust it.
  if (/^\d+$/.test(name)) return Number(name);
  const all = await db.getAll('statuses');
  const lower = name.toLowerCase();
  const match = all.find(s => String(s.name || '').trim().toLowerCase() === lower);
  if (match) return Number(match.id);
  // Auto-create with neutral grey colour, sorted to the bottom so it doesn't
  // disrupt the existing pipeline order. Admin can recolour / reorder later.
  const newId = await db.insert('statuses', {
    name, color: '#94a3b8', sort_order: 900, is_final: 0
  });
  return Number(newId);
}

/**
 * Resolve a product NAME to a product_id. Same pattern as statuses.
 */
async function _resolveProductIdByName(raw) {
  const name = String(raw || '').trim();
  if (!name) return '';
  if (/^\d+$/.test(name)) return Number(name);
  const all = await db.getAll('products');
  const lower = name.toLowerCase();
  const match = all.find(p => String(p.name || '').trim().toLowerCase() === lower);
  if (match) return Number(match.id);
  const newId = await db.insert('products', {
    name, description: '', price: 0, is_active: 1
  });
  return Number(newId);
}

async function api_leads_list(token, filters) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const { usersById, statusesById, productsById, tatByStatusId, finalStatusIds } = await _lookups();
  filters = filters || {};
  let rows = (await db.getAll('leads')).filter(l => _isVisible(me, visible, l));

  if (filters.status_id)   rows = rows.filter(l => Number(l.status_id) === Number(filters.status_id));
  if (filters.source)      rows = rows.filter(l => l.source === filters.source);
  if (filters.product_id)  rows = rows.filter(l => Number(l.product_id) === Number(filters.product_id));
  if (filters.assigned_to) rows = rows.filter(l => Number(l.assigned_to) === Number(filters.assigned_to));
  // Qualified filter:
  //   '1' / 'only' → only leads marked qualified
  //   '0' / 'unqualified' → only leads NOT marked qualified
  if (filters.qualified === '1' || filters.qualified === 'only') {
    rows = rows.filter(l => Number(l.qualified) === 1);
  } else if (filters.qualified === '0' || filters.qualified === 'unqualified') {
    rows = rows.filter(l => Number(l.qualified) !== 1);
  }
  if (filters.from)        rows = rows.filter(l => String(l.created_at).slice(0, 10) >= filters.from);
  if (filters.to)          rows = rows.filter(l => String(l.created_at).slice(0, 10) <= filters.to);
  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    rows = rows.filter(l =>
      String(l.name || '').toLowerCase().includes(q) ||
      String(l.email || '').toLowerCase().includes(q) ||
      String(l.phone || '').toLowerCase().includes(q) ||
      String(l.whatsapp || '').toLowerCase().includes(q) ||
      String(l.notes || '').toLowerCase().includes(q)
    );
  }
  if (filters.followup === 'today') {
    const today = new Date().toISOString().slice(0, 10);
    rows = rows.filter(l => String(l.next_followup_at || '').slice(0, 10) === today);
  } else if (filters.followup === 'overdue') {
    const now = new Date().toISOString();
    rows = rows.filter(l => l.next_followup_at && String(l.next_followup_at) < now);
  }

  // Duplicate filter:
  //   'only'   → show only duplicates
  //   'unique' → show only non-duplicates
  if (filters.duplicate === 'only')        rows = rows.filter(l => Number(l.is_duplicate) === 1);
  else if (filters.duplicate === 'unique') rows = rows.filter(l => Number(l.is_duplicate) !== 1);

  // Sort:
  //   created_desc (default) — newest created leads first
  //   created_asc           — oldest created leads first
  //   updated_desc          — most recently touched leads first
  //   updated_asc           — least recently touched leads first
  // Falls back to created_at if updated_at is null/missing on a row,
  // so freshly imported leads still sort sensibly.
  const sort = String(filters.sort || 'created_desc').toLowerCase();
  const _key = (l) => {
    if (sort.startsWith('updated')) {
      return String(l.updated_at || l.last_status_change_at || l.created_at || '');
    }
    return String(l.created_at || '');
  };
  const _dir = sort.endsWith('_asc') ? 1 : -1;
  rows.sort((a, b) => {
    const av = _key(a), bv = _key(b);
    if (av < bv) return -1 * _dir;
    if (av > bv) return  1 * _dir;
    // Stable tiebreaker on id so paging stays deterministic
    return (Number(a.id) - Number(b.id)) * _dir;
  });
  const total = rows.length;
  const statusCount = {};
  rows.forEach(l => { const sid = Number(l.status_id) || 0; statusCount[sid] = (statusCount[sid] || 0) + 1; });

  const page = Number(filters.page || 1);
  const pageSize = Math.min(Number(filters.page_size || 100), 500);
  rows = rows.slice((page - 1) * pageSize, page * pageSize);

  const remarks = await db.getAll('remarks');
  const remarksByLead = {};
  remarks.forEach(r => {
    const k = Number(r.lead_id);
    const prev = remarksByLead[k];
    if (!prev || String(r.created_at) > String(prev.created_at)) remarksByLead[k] = r;
  });

  const hydrated = rows.map(l => {
    const h = _hydrate(l, usersById, statusesById, productsById, tatByStatusId, finalStatusIds);
    const r = remarksByLead[Number(l.id)];
    h.recent_remark = r ? r.remark : '';
    h.recent_remark_at = r ? r.created_at : '';
    return h;
  });
  return { leads: hydrated, total, page, page_size: pageSize, status_count: statusCount };
}

async function api_leads_statusCounts(token) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const rows = (await db.getAll('leads')).filter(l => _isVisible(me, visible, l));
  const out = {};
  rows.forEach(l => { const k = Number(l.status_id) || 0; out[k] = (out[k] || 0) + 1; });
  return out;
}

async function api_leads_get(token, id) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const lead = await db.findById('leads', id);
  if (!lead) throw new Error('Not found');
  if (!_isVisible(me, visible, lead)) throw new Error('Forbidden');

  const { usersById, statusesById, productsById, tatByStatusId, finalStatusIds } = await _lookups();
  const hydrated = _hydrate(lead, usersById, statusesById, productsById, tatByStatusId, finalStatusIds);

  const remarks = (await db.getAll('remarks'))
    .filter(r => Number(r.lead_id) === Number(id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(r => Object.assign({}, r, {
      user_name: usersById[Number(r.user_id)]?.name || 'System',
      status_name: statusesById[Number(r.status_id)]?.name || ''
    }));
  const followups = (await db.getAll('followups'))
    .filter(f => Number(f.lead_id) === Number(id))
    .sort((a, b) => String(b.due_at).localeCompare(String(a.due_at)))
    .map(f => Object.assign({}, f, { user_name: usersById[Number(f.user_id)]?.name || '' }));
  const messages = (await db.getAll('whatsapp_messages'))
    .filter(m => Number(m.lead_id) === Number(id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  return { lead: hydrated, remarks, followups, messages };
}

async function api_leads_create(token, payload) {
  const me = await authUser(token);
  const p = Object.assign({}, payload || {});
  // CSV-friendly aliasing — accept common header spellings for the
  // migration timestamp columns. Lookup is case-insensitive across the
  // raw payload keys; the first match wins. Empty values are ignored
  // so a blank cell falls back to the default ("now").
  if (!p.created_at) {
    for (const k of Object.keys(p)) {
      if (/^(lead_?)?created[_\s]?(at|date|on)$/i.test(k.replace(/[^a-z_]/gi, ''))) {
        if (p[k] && !p.created_at) p.created_at = p[k];
      }
    }
  }
  if (!p.last_status_change_at) {
    for (const k of Object.keys(p)) {
      if (/^(last[_\s]?)?status[_\s]?(change|changed|update|updated)[_\s]?(at|date|on)?$/i.test(k.replace(/[^a-z_]/gi, ''))) {
        if (p[k] && !p.last_status_change_at) p.last_status_change_at = p[k];
      }
    }
  }
  if (!p.name) throw new Error('name required');

  // Mobile number is required — leads without a contact phone are essentially
  // un-followable, so reject them at the API layer (covers both manual lead
  // form and CSV bulk import). Strip Excel artefacts before checking.
  // Also accept `mobile`, `whatsapp`, `contact` as aliases so CSV uploads with
  // any of those columns still work.
  const _phoneRaw =
    p.phone ?? p.mobile ?? p.contact ?? p.whatsapp ?? p.mobile_number ?? p.contact_number ?? '';
  const _phoneDigits = String(_phoneRaw || '').trim().replace(/^'/, '').replace(/\D/g, '');
  if (!_phoneDigits) throw new Error('Mobile number is required');

  // Bad-quality phone → auto-move to Junk. We accept the lead (so the data
  // isn't silently lost) but mark it for review. Threshold: a real mobile
  // number must be at least 10 digits. Anything shorter is almost certainly
  // a typo or test data — flagging as Junk surfaces it to the manager
  // without polluting the active pipeline.
  let _autoJunk = false;
  if (_phoneDigits.length < 10) _autoJunk = true;

  // Resolve assigned_to: accepts integer ID, email, or full name.
  // Recognises common CSV column aliases people actually use:
  //   assigned_to / user / owner / assignee / sales_rep / salesperson / agent
  let resolvedAssignee = '';
  const rawAssignSrc =
    p.assigned_to ?? p.user ?? p.owner ?? p.assignee ??
    p.sales_rep ?? p.salesperson ?? p.agent ?? p.assigned_user ?? p.rep ?? '';
  const rawAssign = String(rawAssignSrc || '').trim();
  if (rawAssign) {
    if (/^\d+$/.test(rawAssign)) {
      resolvedAssignee = Number(rawAssign);
    } else {
      const allUsers = await db.getAll('users');
      const lower = rawAssign.toLowerCase();
      const norm  = lower.replace(/\s+/g, ' '); // collapse internal spaces too
      const byEmail = allUsers.find(u => String(u.email || '').trim().toLowerCase() === lower);
      const byName  = allUsers.find(u => String(u.name  || '').trim().toLowerCase() === norm);
      // Fallback: case-insensitive substring match (handles "Manoj" vs "Manoj Kumar ")
      const byPartial = !byEmail && !byName
        ? allUsers.find(u => {
            const n = String(u.name || '').trim().toLowerCase();
            return n && (n === norm || n.includes(norm) || norm.includes(n));
          })
        : null;
      if (byEmail) resolvedAssignee = Number(byEmail.id);
      else if (byName) resolvedAssignee = Number(byName.id);
      else if (byPartial) resolvedAssignee = Number(byPartial.id);
      // If we couldn't resolve, leave blank so assignment rules can take over
    }
  }

  // Normalize phone — strip Excel artefacts (leading apostrophe used to force text)
  const cleanPhone = String(p.phone || '').trim().replace(/^'/, '');
  const cleanWA    = String(p.whatsapp || cleanPhone || '').trim().replace(/^'/, '');

  // Resolve status_id: prefer numeric `status_id`, otherwise look up `status`
  // by NAME (the natural shape of CSV imports). Auto-creates missing statuses.
  // Same idea for product_id / product.
  const resolvedStatusId = p.status_id
    ? Number(p.status_id)
    : await _resolveStatusIdByName(p.status);
  const resolvedProductId = p.product_id
    ? Number(p.product_id)
    : (p.product ? await _resolveProductIdByName(p.product) : '');

  // Auto-junk override: short phone wins over any explicit status the
  // caller passed. This keeps test data and typos out of the live pipeline.
  let _statusId;
  if (_autoJunk) {
    _statusId = await _junkStatusId();
  } else {
    _statusId = resolvedStatusId || (await _newStatusId());
  }

  // Custom-field collection — the bulk-upload sample CSV exposes one
  // column per custom field as `cf_<key>`. Collect those into the `extra`
  // map so they land in extra_json. (Programmatic API callers can also
  // pass `p.extra` as a pre-built object — that wins if present.)
  let extraObj = (p.extra && typeof p.extra === 'object') ? Object.assign({}, p.extra) : {};
  for (const key of Object.keys(p)) {
    if (key.startsWith('cf_') && p[key] !== '' && p[key] != null) {
      extraObj[key.slice(3)] = String(p[key]);
    }
  }
  // Coerce numeric `value` cleanly — strip "₹", commas, spaces.
  const cleanValue = (() => {
    const raw = String(p.value ?? '').trim().replace(/[₹$,\s]/g, '');
    if (!raw) return null;
    const n = Number(raw);
    return isFinite(n) ? n : null;
  })();

  // Lead-cap enforcement. Admin manual creates bypass (admin knows what
  // they're doing); auto-routed leads (website webhook, assignment
  // rules, CSV imports without per-row override) honour it. If the
  // resolved assignee is at cap, the lead lands UNASSIGNED — admin
  // sees it on the dashboard and can route it manually.
  let _capWarning = null;
  const _adminBypass = me.role === 'admin' && p.cap_bypass === true;
  let _proposedAssignee = resolvedAssignee || me.id;
  if (_proposedAssignee && !_adminBypass) {
    const capCheck = await _canAssignToUser(_proposedAssignee, false);
    if (!capCheck.ok) {
      _capWarning = capCheck.reason + ' for user #' + _proposedAssignee;
      // For round-robin / percent at the bulk layer, _pickUncappedUser
      // already rotated past capped reps. At single-create time we
      // simply leave the lead unassigned with a warning remark; manual
      // admin re-routing is the right escape hatch.
      _proposedAssignee = null;
    }
  }

  let base = {
    name: String(p.name).trim(),
    email: String(p.email || '').trim(),
    phone: cleanPhone,
    alt_phone: String(p.alt_phone || '').trim().replace(/^'/, ''),
    whatsapp: cleanWA,
    source: p.source || 'manual',
    source_ref: p.source_ref || '',
    product_id: resolvedProductId,
    status_id: _statusId,
    assigned_to: _proposedAssignee || null,
    // Address block — accepted for migration imports; lead form already
    // captures city, the rest is opt-in.
    address: p.address || '',
    city:    p.city    || '',
    state:   p.state   || '',
    pincode: p.pincode || '',
    country: p.country || '',
    company: p.company || '',
    // Deal value — useful for forecasting reports.
    value:    cleanValue,
    currency: p.currency || '',
    tags: p.tags || '',
    notes: _autoJunk
      ? ('⚠ Auto-flagged Junk: phone "' + (cleanPhone || _phoneDigits) + '" has only ' + _phoneDigits.length + ' digits.\n' + (p.notes || ''))
      : (p.notes || ''),
    extra_json: Object.keys(extraObj).length ? JSON.stringify(extraObj) : '',
    // Attribution columns — passed through from the API (and the website
    // webhook). Useful for filtering and reporting on Google Ads.
    gclid:          p.gclid || '',
    gad_campaignid: p.gad_campaignid || '',
    utm_source:     p.utm_source || '',
    utm_medium:     p.utm_medium || '',
    utm_campaign:   p.utm_campaign || '',
    utm_term:       p.utm_term || '',
    utm_content:    p.utm_content || '',
    next_followup_at: p.next_followup_at || '',
    // Migration support — admins can override last_status_change_at when
    // importing leads from another CRM so TAT calculations reflect the
    // source system. Non-admins (or empty values) get "now".
    last_status_change_at: (me.role === 'admin' && p.last_status_change_at)
      ? _parseDate(p.last_status_change_at)
      : db.nowIso(),
    created_by: me.id,
    // Qualified flag — the form's checkbox sends 0/1; previously dropped
    // by the create path so the lead saved as "not qualified" even if the
    // rep ticked it. Persist + stamp who marked it and when, mirroring the
    // update-flow behaviour.
    qualified:    Number(p.qualified) === 1 ? 1 : 0,
    qualified_at: Number(p.qualified) === 1 ? db.nowIso() : null,
    qualified_by: Number(p.qualified) === 1 ? me.id : null
  };
  const dup = await _applyDuplicatePolicy(base, me.id);
  base = dup.payload;
  base.is_duplicate = dup.duplicate ? 1 : 0;
  // Also flag is_duplicate=1 if the row's tag/notes explicitly say "Duplicate"
  // — common in spreadsheets exported from older CRMs where users tag dupes
  // manually. Word-boundary match so "Not Duplicate" doesn't trigger.
  if (!base.is_duplicate && /\b(duplicate|dup)\b/i.test(String(base.tags || ''))) {
    base.is_duplicate = 1;
  }
  base.duplicate_of = dup.duplicate ? dup.matched_id : '';

  // Duplicate handling — force a fresh "Pending" status on the new row so
  // a re-enquiry doesn't masquerade as already-progressed. The CSV import,
  // website webhook, or whoever called us may have passed the original's
  // status by accident; we override here unconditionally for duplicates.
  if (dup.duplicate) {
    base.status_id = await _pendingStatusId();
    base.last_status_change_at = db.nowIso();
  }

  // Block a rep from scheduling two follow-ups at the same minute.
  if (base.next_followup_at) {
    await _assertFollowupSlotFree(me, base.assigned_to || me.id, base.next_followup_at, null);
  }

  // Migration: admins can backdate created_at when importing from
  // another CRM. The DB column has DEFAULT NOW(), so leaving the key
  // off the insert keeps that behaviour for everyone else.
  if (me.role === 'admin' && p.created_at) {
    const parsed = _parseDate(p.created_at);
    if (parsed) base.created_at = parsed;
  }

  const id = await db.insert('leads', base);

  // If we deflected an auto-assignment due to a cap, record the trail
  // so admins reviewing the unassigned queue know why the lead is here.
  if (_capWarning) {
    try {
      await db.insert('remarks', {
        lead_id: id, user_id: me.id,
        remark: '⛔ Auto-assignment skipped: ' + _capWarning + '. Lead left unassigned for manual review.',
        status_id: ''
      });
    } catch (_) {}
  }

  if (dup.duplicate) {
    // Flag on the new (duplicate) row.
    await db.insert('remarks', {
      lead_id: id, user_id: me.id,
      remark: '⚠️ Duplicate of lead #' + dup.matched_id + ' (policy: ' + (process.env.DUPLICATE_POLICY || 'allow') + ')',
      status_id: ''
    });
    // Trail on the ORIGINAL row so its recent-remark column tells the rep
    // that an enquiry just came in again. This is what makes the original
    // lead visible to the rep even when policy=assign_same_user routes
    // the new row directly to them.
    try {
      const assigneeNote = dup.matched_assigned_to
        ? ' (reassigned to existing owner)'
        : '';
      await db.insert('remarks', {
        lead_id: dup.matched_id,
        user_id: me.id,
        remark: '🔁 Duplicate lead #' + id + ' created' + assigneeNote +
                '. New enquiry from same contact details.',
        status_id: ''
      });
      // Bump the matched lead's last-touch timestamp so list/sort by recent
      // activity surfaces it. Wrap so a missing column doesn't break creation.
      await db.update('leads', dup.matched_id, { updated_at: db.nowIso() });
    } catch (e) {
      console.warn('[duplicate] failed to annotate original lead:', e.message);
    }
  }
  // Sync followup + fire automations
  if (base.next_followup_at) {
    await _syncFollowup(id, base.assigned_to || me.id, base.next_followup_at, '');
  }
  try { require('../utils/automations').fire('lead_created', { lead: Object.assign({ id }, base), user: me }); } catch (_) {}

  // ---- Email notifications (fire-and-forget) ----
  setImmediate(async () => {
    try {
      const mailer = require('../utils/mailer');
      const cfg = (await db.getAll('config').catch(() => [])).reduce((a, r) => (a[r.key] = r.value, a), {});
      const baseUrl = cfg.BASE_URL || process.env.BASE_URL || '';
      const lead_url = baseUrl ? baseUrl + '/#/leads' : '#/leads';

      const ctx = {
        name: base.name, phone: base.phone, email: base.email,
        source: base.source, city: base.city, tags: base.tags,
        notes: base.notes,
        lead_url
      };

      // 1. New lead → admins + manager(s)
      const adminUsers = (await db.getAll('users')).filter(u =>
        u.email && (u.role === 'admin' || u.role === 'manager') && Number(u.is_active) === 1
      );
      for (const u of adminUsers) {
        await mailer.sendEvent('new_lead', Object.assign({ to: u.email }, ctx));
      }
      // 2. Lead assigned → the assignee (if not the same person who created it)
      if (resolvedAssignee && Number(resolvedAssignee) !== Number(me.id)) {
        const assignee = await db.findById('users', resolvedAssignee).catch(() => null);
        if (assignee && assignee.email) {
          await mailer.sendEvent('lead_assigned', Object.assign({ to: assignee.email }, ctx, {
            assigned_name: assignee.name,
            assigned_first_name: (assignee.name || '').split(' ')[0],
            assigned_email: assignee.email
          }));
        }
      }
    } catch (e) { console.warn('[mailer] lead_created notify failed:', e.message); }

    // ---- Web Push (SMS-style) — fires on user's phone even if app is closed ----
    try {
      const push = require('./push');
      if (resolvedAssignee && Number(resolvedAssignee) !== Number(me.id)) {
        await push.sendPushToUser(resolvedAssignee, {
          title: '🎯 New lead assigned',
          body:  `${base.name || 'Unknown'} ${base.phone ? '· ' + base.phone : ''}${base.source ? '\nSource: ' + base.source : ''}`,
          url:   '/#/leads',
          tag:   'lead-' + id,
          sticky: true
        });
      }
    } catch (e) { console.warn('[push] lead_assigned failed:', e.message); }

    // ---- Auto-dial: send a "📞 Tap to call" push to the assignee in
    // addition to the generic "new lead assigned" notification above.
    // Tapping the notification opens /#/dial?phone=… on the APK which
    // auto-fires tel: and launches the dialer with the number pre-filled.
    //
    // Gating: ALL of the following must be true to send the push —
    //   - LEAD_AUTODIAL_ON tenant config is '1' (admin global toggle)
    //   - Lead has an assignee, a phone, and isn't auto-junk
    //   - Assignee is NOT an admin (admins don't work the pipeline)
    //   - Assignee's users.autodial_on column is 1 (per-user opt-in)
    try {
      const autodialOn = await db.getConfig('LEAD_AUTODIAL_ON', '1');
      if (String(autodialOn) === '1' && resolvedAssignee && base.phone && !_autoJunk) {
        const assignee = await db.findById('users', resolvedAssignee);
        const skipAdmin = assignee && String(assignee.role || '').toLowerCase() === 'admin';
        const userOptIn = !assignee || Number(assignee.autodial_on != null ? assignee.autodial_on : 1) === 1;
        if (!skipAdmin && userOptIn) {
          const push = require('./push');
          let digits = String(base.phone).replace(/\D/g, '');
          if (digits.length === 10 && /^[6-9]/.test(digits)) digits = '91' + digits;
          const dial = '+' + digits;
          await push.sendPushToUser(resolvedAssignee, {
            title: '📞 Auto-dial: ' + (base.name || 'New lead'),
            body:  base.phone + (base.source ? '\n' + base.source : '') + '\nTap to call now',
            url:   '/#/dial?phone=' + encodeURIComponent(dial) + '&lead=' + id,
            tag:   'autodial-' + id,
            sticky: false
          });
          // Log a call_events row so the recording-sync pipeline (if used)
          // has a reference point to match against. Mirrors api_call_via_mobile.
          try {
            await db.insert('call_events', {
              lead_id: id, user_id: resolvedAssignee, phone: base.phone,
              direction: 'out', event: 'autodial_requested', duration_s: 0,
              recording_id: null, created_at: db.nowIso()
            });
          } catch (_) {}
        }
      }
    } catch (e) { console.warn('[push] autodial failed:', e.message); }

    // ---- TAT — log the lead-created action and the initial stage entry ----
    try {
      const tat = require('./tat');
      await tat.logAction(id, 'created', me.id, { source: base.source });
      // Initial stage entry: from=null, to=initialStatus
      await db.query(
        `INSERT INTO lead_stage_log (lead_id, from_status_id, to_status_id, user_id) VALUES ($1, $2, $3, $4)`,
        [Number(id), null, base.status_id || null, me.id]
      );
    } catch (e) { console.warn('[tat] create-log failed:', e.message); }
  });

  return { id, duplicate: dup.duplicate, matched_id: dup.matched_id };
}

// Fields that originate from the customer / campaign and must never be edited
// by anyone below admin once the lead has been created. This protects against:
//   - Reps "fixing" a typo that's actually how the customer filled the form
//     (and losing the original value forever)
//   - Managers tweaking the source/UTM to make their numbers look better
//   - Any non-admin overriding gclid/UTMs (which Google Ads conversion
//     tracking depends on)
// Admin can change them — for legitimate corrections after talking to the
// customer.
const CAMPAIGN_LOCKED_FIELDS = [
  'name', 'phone', 'whatsapp', 'email',
  'source', 'source_ref',
  'gclid', 'gad_campaignid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'
];

async function api_leads_update(token, id, patch) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const lead = await db.findById('leads', id);
  if (!lead) throw new Error('Not found');
  if (!_isVisible(me, visible, lead)) throw new Error('Forbidden');

  // Non-admins: silently strip campaign-locked fields from the patch BEFORE
  // we copy values into `allowed`. Defense in depth — frontend also shows
  // these inputs as readonly, but a determined user could still POST to the
  // API directly. The strip here is the source of truth.
  if (me.role !== 'admin') {
    const blocked = [];
    for (const f of CAMPAIGN_LOCKED_FIELDS) {
      if (f in patch && String(patch[f] || '') !== String(lead[f] || '')) {
        blocked.push(f);
        delete patch[f];
      }
    }
    if (blocked.length > 0) {
      // Don't fail the whole save — just record it. The legitimate edits in
      // the same patch (status, follow-up, notes) should still succeed.
      console.warn(
        `[leads] non-admin user ${me.id} (${me.role}) tried to change locked campaign fields on lead ${id}: ${blocked.join(', ')} — ignored`
      );
    }
  }

  const allowed = {};
  ['name', 'email', 'phone', 'whatsapp', 'product_id', 'status_id', 'assigned_to',
   'city', 'state', 'pincode', 'country', 'company', 'address',
   'notes', 'next_followup_at', 'tags', 'source', 'source_ref',
   'value', 'currency', 'qualified',
   // Inventory match inputs (used by api_inventory_match)
   'budget_max', 'requirement_type', 'requirement_notes',
   // Attribution / Google Ads columns
   'gclid', 'gad_campaignid', 'utm_source', 'utm_medium',
   'utm_campaign', 'utm_term', 'utm_content']
    .forEach(k => { if (k in patch) allowed[k] = patch[k]; });
  allowed.updated_at = db.nowIso();
  // Track who marked the lead as qualified, and when. Only update these
  // when the qualified flag actually changes (don't overwrite on no-op saves).
  if ('qualified' in patch) {
    const wasQualified = Number(lead.qualified) === 1;
    const nowQualified = Number(patch.qualified) === 1;
    if (wasQualified !== nowQualified) {
      allowed.qualified = nowQualified ? 1 : 0;
      allowed.qualified_at = nowQualified ? db.nowIso() : null;
      allowed.qualified_by = nowQualified ? me.id : null;
      try { require('./tat').logAction(id, nowQualified ? 'qualified' : 'unqualified', me.id, {}); } catch (_) {}
    }
  }

  if (patch.extra && typeof patch.extra === 'object') {
    const curr = _parseExtra(lead);
    allowed.extra_json = JSON.stringify(Object.assign({}, curr, patch.extra));
  }
  const statusChanged = patch.status_id && Number(patch.status_id) !== Number(lead.status_id);
  const assigneeChanged = patch.assigned_to && Number(patch.assigned_to) !== Number(lead.assigned_to);
  if (statusChanged) allowed.last_status_change_at = db.nowIso();

  // Block a rep from scheduling two follow-ups at the same minute. Run
  // BEFORE the lead update so a clash leaves the row untouched.
  if ('next_followup_at' in patch && patch.next_followup_at) {
    // The follow-up belongs to whoever currently owns the lead — either
    // the new assignee from this same patch or the existing owner.
    const ownerId = patch.assigned_to || lead.assigned_to || me.id;
    await _assertFollowupSlotFree(me, ownerId, patch.next_followup_at, id);
  }

  await db.update('leads', id, allowed);

  // Sync next_followup_at → followups table so reminder/notification views find it
  if ('next_followup_at' in patch) {
    await _syncFollowup(id, me.id, patch.next_followup_at, patch.followup_note || '');
  }

  if (statusChanged) {
    const s = await db.findById('statuses', patch.status_id);
    await db.insert('remarks', {
      lead_id: id, user_id: me.id,
      remark: 'Status changed to ' + (s ? s.name : ''),
      status_id: patch.status_id
    });
    // Fire automations
    try { require('../utils/automations').fire('status_changed', { lead: Object.assign({}, lead, allowed), user: me, new_status: s }); } catch (_) {}
    // TAT — write stage log + close any open violation for this lead
    try { await require('./tat').logStageChange(id, lead.status_id, patch.status_id, me.id); } catch (_) {}
    // Stamp last_status_change_at so the TAT worker knows when this lead entered the new stage
    try { await db.update('leads', id, { last_status_change_at: db.nowIso() }); } catch (_) {}
  }
  // Note (the lead's `notes` column) updated by this save → log so it
  // shows in the activity timeline. Only fires when the value actually
  // changed, to avoid a noisy timeline on every unrelated save.
  if ('notes' in patch && String(patch.notes || '') !== String(lead.notes || '')) {
    try { require('./tat').logAction(id, 'note_updated', me.id, { preview: String(patch.notes || '').slice(0, 200) }); } catch (_) {}
  }
  // Lead-form fields that the user might want to track changes on
  if ('next_followup_at' in patch && patch.next_followup_at !== lead.next_followup_at) {
    try { require('./tat').logAction(id, 'followup_set', me.id, { due_at: patch.next_followup_at }); } catch (_) {}
  }
  if ('tags' in patch && String(patch.tags || '') !== String(lead.tags || '')) {
    try { require('./tat').logAction(id, 'tags_updated', me.id, { tags: patch.tags || '' }); } catch (_) {}
  }

  if (assigneeChanged) {
    try { require('../utils/automations').fire('lead_assigned', { lead: Object.assign({}, lead, allowed), user: me }); } catch (_) {}
    try { require('./tat').logAction(id, 'assigned', me.id, { from: lead.assigned_to, to: patch.assigned_to }); } catch (_) {}
    // Direct push to the new assignee — same SMS-style banner the lead-create
    // flow uses. Fire-and-forget so we don't block the response.
    setImmediate(async () => {
      try {
        const newAssignee = Number(patch.assigned_to);
        if (!newAssignee || newAssignee === Number(me.id)) return;
        const push = require('./push');
        const updatedLead = Object.assign({}, lead, allowed);
        await push.sendPushToUser(newAssignee, {
          title: '🎯 Lead reassigned to you',
          body:  `${updatedLead.name || 'Unknown'}${updatedLead.phone ? ' · ' + updatedLead.phone : ''}${updatedLead.source ? '\nSource: ' + updatedLead.source : ''}`,
          url:   '/#/leads',
          tag:   'lead-' + id,
          sticky: true
        });
      } catch (e) { console.warn('[push] reassign notify failed:', e.message); }
    });
  }
  return { ok: true };
}

/**
 * Guard against a single rep double-booking the same minute on two
 * different leads. Throws a friendly error naming the conflicting lead
 * so the rep can re-pick a slot.
 *
 * Compares via UTC milliseconds floored to the minute, so a timezone
 * difference between the candidate and an existing row can't sneak
 * past the check. Admins are exempt — they often shift schedules
 * around on behalf of their team and this rule would block legitimate
 * bulk operations.
 *
 * Same lead being rescheduled = no clash (excludeLeadId).
 * Done / completed follow-ups don't count (is_done=1).
 * Empty or invalid due_at = no check.
 */
async function _assertFollowupSlotFree(me, userId, dueAt, excludeLeadId) {
  if (!dueAt || me.role === 'admin') return;
  const candidateMs = new Date(dueAt).getTime();
  if (!isFinite(candidateMs)) return;
  const minuteKey = Math.floor(candidateMs / 60000);
  const all = await db.getAll('followups');
  const conflict = all.find(f =>
    Number(f.user_id) === Number(userId) &&
    Number(f.is_done) !== 1 &&
    Number(f.lead_id) !== Number(excludeLeadId || 0) &&
    f.due_at &&
    Math.floor(new Date(f.due_at).getTime() / 60000) === minuteKey
  );
  if (!conflict) return;
  // Hydrate the conflicting lead's name + the human-readable time so the
  // toast tells the rep exactly what's already on their calendar.
  const otherLead = await db.findById('leads', conflict.lead_id).catch(() => null);
  const niceTime = new Date(conflict.due_at).toLocaleString('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit'
  });
  const otherName = otherLead?.name || ('lead #' + conflict.lead_id);
  throw new Error(
    'Follow-up clash: you already have "' + otherName + '" scheduled at ' +
    niceTime + '. Pick a different time.'
  );
}

// Sync helper — creates or updates a followup row when the lead's next_followup_at changes
async function _syncFollowup(leadId, userId, dueAt, note) {
  const existing = (await db.getAll('followups')).filter(f =>
    Number(f.lead_id) === Number(leadId) && Number(f.is_done) === 0
  );
  if (!dueAt) {
    // Mark existing open follow-ups done
    for (const f of existing) await db.update('followups', f.id, { is_done: 1, done_at: db.nowIso() });
    return;
  }
  if (existing.length > 0) {
    await db.update('followups', existing[0].id, { due_at: dueAt, note: note || existing[0].note || '' });
    for (let i = 1; i < existing.length; i++) {
      await db.update('followups', existing[i].id, { is_done: 1, done_at: db.nowIso() });
    }
  } else {
    await db.insert('followups', {
      lead_id: leadId, user_id: userId, due_at: dueAt,
      note: note || '', is_done: 0, created_at: db.nowIso()
    });
  }
}

async function api_leads_addRemark(token, leadId, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.remark) throw new Error('remark required');
  // Was the status changed by this remark? If so, capture the prior status_id
  const lead = await db.findById('leads', leadId);
  const priorStatus = lead ? Number(lead.status_id) : null;
  // Block a rep from scheduling two follow-ups at the same minute via
  // the addRemark shortcut. Run BEFORE persisting the remark so a
  // clash leaves nothing on the lead.
  if (p.next_followup_at) {
    const ownerId = lead?.assigned_to || me.id;
    await _assertFollowupSlotFree(me, ownerId, p.next_followup_at, leadId);
  }

  await db.insert('remarks', {
    lead_id: leadId, user_id: me.id,
    remark: p.remark, status_id: p.status_id || ''
  });
  const leadPatch = { updated_at: db.nowIso() };
  if (p.status_id) leadPatch.status_id = p.status_id;
  if (p.next_followup_at) leadPatch.next_followup_at = p.next_followup_at;
  if (p.status_id && Number(p.status_id) !== priorStatus) leadPatch.last_status_change_at = db.nowIso();
  await db.update('leads', leadId, leadPatch);
  if (p.next_followup_at) {
    await db.insert('followups', {
      lead_id: leadId, user_id: me.id,
      due_at: p.next_followup_at, note: p.remark, is_done: 0
    });
  }
  // TAT — every remark counts as an action; status change also writes stage_log.
  try {
    const tat = require('./tat');
    await tat.logAction(leadId, 'remark', me.id, { remark: String(p.remark).slice(0, 200) });
    if (p.status_id && Number(p.status_id) !== priorStatus) {
      await tat.logStageChange(leadId, priorStatus, Number(p.status_id), me.id);
    }
    if (p.next_followup_at) {
      await tat.logAction(leadId, 'followup_set', me.id, { due_at: p.next_followup_at });
    }
  } catch (_) {}
  return { ok: true };
}

async function api_leads_pipeline(token) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const { usersById, statusesById, productsById, tatByStatusId, finalStatusIds } = await _lookups();
  const statuses = (await db.getAll('statuses')).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  const leads = (await db.getAll('leads')).filter(l => _isVisible(me, visible, l));
  return statuses.map(s => {
    const cols = leads
      .filter(l => Number(l.status_id) === Number(s.id))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, 100)
      .map(l => _hydrate(l, usersById, statusesById, productsById, tatByStatusId, finalStatusIds));
    return Object.assign({}, s, { leads: cols });
  });
}

async function api_myFollowups(token) {
  const me = await authUser(token);
  const leadsById = {};
  (await db.getAll('leads')).forEach(l => { leadsById[Number(l.id)] = l; });
  return (await db.getAll('followups'))
    .filter(f => Number(f.user_id) === Number(me.id) && Number(f.is_done) === 0)
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))
    .map(f => {
      const l = leadsById[Number(f.lead_id)] || {};
      return Object.assign({}, f, {
        lead_name: l.name || '', lead_phone: l.phone || '', lead_whatsapp: l.whatsapp || ''
      });
    });
}

async function api_followup_done(token, id) {
  await authUser(token);
  await db.update('followups', id, { is_done: 1, done_at: db.nowIso() });
  return { ok: true };
}

async function api_leads_bulkUpdate(token, leadIds, patch) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) throw new Error('Forbidden');
  const allowed = {};
  ['assigned_to', 'status_id', 'source', 'product_id'].forEach(k => { if (k in patch) allowed[k] = patch[k]; });
  if (patch.status_id) allowed.last_status_change_at = db.nowIso();
  // Track per-assignee bulk pushes — one summary push per recipient instead of
  // 200 spammy banners if you reassign 200 leads.
  const reassignedPerUser = {}; // userId -> [leadName, leadName, ...]
  const newAssignee = (patch.assigned_to !== undefined && patch.assigned_to !== '')
    ? Number(patch.assigned_to) : null;
  let count = 0;
  for (const id of (leadIds || [])) {
    const lead = await db.findById('leads', id); if (!lead) continue;
    const wasAssignedTo = Number(lead.assigned_to) || 0;
    await db.update('leads', id, allowed);
    if (patch.status_id && Number(patch.status_id) !== Number(lead.status_id)) {
      const s = await db.findById('statuses', patch.status_id);
      await db.insert('remarks', { lead_id: id, user_id: me.id, remark: 'Status changed to ' + (s ? s.name : '') + ' (bulk)', status_id: patch.status_id });
    }
    if (newAssignee && newAssignee !== wasAssignedTo && newAssignee !== Number(me.id)) {
      if (!reassignedPerUser[newAssignee]) reassignedPerUser[newAssignee] = [];
      reassignedPerUser[newAssignee].push(lead.name || ('Lead #' + id));
    }
    count++;
  }
  // Single summary push per assignee — fire-and-forget so the bulk update
  // returns instantly even if FCM/Web Push are slow.
  setImmediate(async () => {
    try {
      const push = require('./push');
      for (const uid of Object.keys(reassignedPerUser)) {
        const names = reassignedPerUser[uid];
        const preview = names.slice(0, 3).join(', ') + (names.length > 3 ? ' …' : '');
        await push.sendPushToUser(Number(uid), {
          title: `🎯 ${names.length} new lead${names.length > 1 ? 's' : ''} assigned`,
          body:  preview,
          url:   '/#/leads',
          tag:   'bulk-assign-' + uid,
          sticky: true
        });
      }
    } catch (e) { console.warn('[push] bulk reassign notify failed:', e.message); }
  });
  return { ok: true, count };
}

/**
 * Delete all leads marked is_duplicate=1.
 * Returns the count of leads deleted. The corresponding remarks/followups
 * are removed via ON DELETE CASCADE.
 */
/**
 * Backfill — scan every existing lead, find those with phone digits < 10,
 * and move them to the Junk status. Logs the change as an action so it's
 * visible in each lead's activity timeline. Only admin / manager can run.
 *
 * Returns { ok, moved, skipped, junk_status_id }.
 */
async function api_leads_cleanupJunk(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const junkId = await _junkStatusId();
  const all = await db.getAll('leads');
  let moved = 0; let skipped = 0;
  for (const l of all) {
    const phoneDigits = String(l.phone || '').replace(/\D/g, '');
    if (!phoneDigits || phoneDigits.length >= 10) { skipped++; continue; }
    if (Number(l.status_id) === Number(junkId)) { skipped++; continue; }
    try {
      await db.update('leads', l.id, {
        status_id: junkId,
        last_status_change_at: db.nowIso(),
        notes: '⚠ Auto-flagged Junk by backfill: phone "' + (l.phone || '') + '" has only ' + phoneDigits.length + ' digits.\n' + (l.notes || '')
      });
      // Stage log + action so it shows in the activity timeline
      try {
        const tat = require('./tat');
        await tat.logStageChange(l.id, l.status_id, junkId, me.id);
        await tat.logAction(l.id, 'status_change', me.id, { from_status_id: l.status_id, to_status_id: junkId, reason: 'auto_junk_backfill', phone_digits: phoneDigits.length });
      } catch (_) {}
      moved++;
    } catch (e) {
      console.warn('[junk_backfill] lead ' + l.id + ' failed:', e.message);
      skipped++;
    }
  }
  return { ok: true, moved, skipped, total: all.length, junk_status_id: junkId };
}

async function api_leads_deleteAllDuplicates(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const dups = (await db.getAll('leads')).filter(l => Number(l.is_duplicate) === 1);
  let count = 0;
  for (const lead of dups) {
    if (await db.removeRow('leads', lead.id)) count++;
  }
  return { ok: true, count };
}

async function api_leads_bulkDelete(token, leadIds) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  let count = 0;
  for (const id of (leadIds || [])) { if (await db.removeRow('leads', id)) count++; }
  return { ok: true, count };
}

/**
 * Bulk-create leads from a CSV upload, with flexible assignment.
 *
 * `assign` shape:
 *   { mode: 'csv' }                              // honour the assigned_to column on each row (or assignment rules)
 *   { mode: 'single', user_id: 5 }               // assign every lead to user 5
 *   { mode: 'round_robin', user_ids: [3,7,9] }   // round-robin across these users (or all sales users if omitted)
 *   { mode: 'percent', split: { 3: 60, 7: 30, 9: 10 } }   // 60/30/10 split across users 3, 7, 9
 */
async function api_leads_bulkCreate(token, rows, assign) {
  const me = await authUser(token);
  const results = { ok: true, created: 0, skipped: 0, duplicate: 0, assignedCounts: {}, errors: [] };
  const assignment = assign || { mode: 'csv' };
  const total = (rows || []).length;

  // Pre-resolve the user list for round_robin / percent modes
  let users = [];
  if (assignment.mode === 'round_robin' || assignment.mode === 'percent') {
    const all = await db.getAll('users');
    users = all.filter(u => Number(u.is_active) === 1 && u.role !== 'admin');
  }

  // Build a per-row assignment plan up front (deterministic, easier to debug)
  const plan = new Array(total).fill(null);

  if (assignment.mode === 'single') {
    const uid = Number(assignment.user_id);
    if (!uid) throw new Error('user_id required for single-assign mode');
    for (let i = 0; i < total; i++) plan[i] = uid;

  } else if (assignment.mode === 'round_robin') {
    const ids = (assignment.user_ids && assignment.user_ids.length)
      ? assignment.user_ids.map(Number)
      : users.map(u => Number(u.id));
    if (!ids.length) throw new Error('No users selected for round-robin');
    for (let i = 0; i < total; i++) plan[i] = ids[i % ids.length];

  } else if (assignment.mode === 'percent') {
    const split = assignment.split || {};
    const pairs = Object.entries(split).map(([uid, pct]) => [Number(uid), Number(pct)]).filter(([u, p]) => u && p > 0);
    if (!pairs.length) throw new Error('At least one user with a positive % required');
    const sumPct = pairs.reduce((s, [, p]) => s + p, 0);
    if (sumPct <= 0) throw new Error('Percentages must sum to >0');
    // Build a deterministic queue by allocating ceil(pct/100 * total) per user, then trimming
    const queue = [];
    for (const [uid, pct] of pairs) {
      const want = Math.round((pct / sumPct) * total);
      for (let i = 0; i < want; i++) queue.push(uid);
    }
    // Round/clip to exact total
    while (queue.length < total) queue.push(pairs[0][0]);
    queue.length = total;
    // Shuffle a tiny bit so consecutive rows aren't all on one rep — Fisher-Yates with seeded prng would be fine,
    // but a simple interleave is plenty here.
    for (let i = 0; i < total; i++) plan[i] = queue[i];
  }
  // mode 'csv' (default): leave plan[i] = null → use the row's own assigned_to (or assignment rules)

  // Track how many leads each user has already been assigned in THIS
  // batch so the cap math is accurate even before the rows commit to
  // the DB. Without this, every row would query the DB and see the
  // same pre-batch counts.
  const inBatchAssigned = {};
  // Helper: re-rotate to the next user who is under cap, accounting
  // for both DB counts and rows already planned in this batch.
  const _findNextUncapped = async (candidates, startIdx) => {
    if (!candidates.length) return null;
    for (let off = 0; off < candidates.length; off++) {
      const idx = (startIdx + off) % candidates.length;
      const uid = Number(candidates[idx]);
      const u = await db.findById('users', uid).catch(() => null);
      if (!u) continue;
      const dCap = Number(u.daily_lead_cap) || 0;
      const mCap = Number(u.monthly_lead_cap) || 0;
      if (dCap <= 0 && mCap <= 0) return uid;
      const r = await _canAssignToUser(uid, false);
      if (!r.ok) continue;
      const usedThisBatch = Number(inBatchAssigned[uid] || 0);
      if (dCap > 0 && (Number(r.daily_used || 0) + usedThisBatch) >= dCap) continue;
      if (mCap > 0 && (Number(r.monthly_used || 0) + usedThisBatch) >= mCap) continue;
      return uid;
    }
    return null;
  };

  for (let i = 0; i < total; i++) {
    const r = Object.assign({}, rows[i]);
    let planned = plan[i] || null;

    // Cap-aware re-rotation for round_robin / percent. Lands the lead
    // on the next uncapped user instead of dumping it on someone full.
    if (planned && (assignment.mode === 'round_robin' || assignment.mode === 'percent')) {
      const candidates = (assignment.mode === 'round_robin'
        ? ((assignment.user_ids && assignment.user_ids.length) ? assignment.user_ids : users.map(u => u.id))
        : Array.from(new Set(plan.filter(Boolean))));
      // Start the search at the originally-planned user
      const startIdx = Math.max(0, candidates.findIndex(x => Number(x) === Number(planned)));
      const uncapped = await _findNextUncapped(candidates.map(Number), startIdx);
      if (uncapped) {
        planned = uncapped;
      } else {
        // Every candidate is at cap → leave unassigned, admin reviews.
        planned = null;
      }
    }
    if (planned) r.assigned_to = planned;
    else if (assignment.mode === 'round_robin' || assignment.mode === 'percent') r.assigned_to = '';

    try {
      if (!r.name) { results.skipped++; results.errors.push({ row: i + 1, error: 'missing name' }); continue; }
      const out = await api_leads_create(token, r);
      if (planned) inBatchAssigned[planned] = (inBatchAssigned[planned] || 0) + 1;
      results.created++;
      if (out.duplicate) results.duplicate++;
      const finalAssignee = r.assigned_to || (out && out.assigned_to) || 'unassigned';
      results.assignedCounts[finalAssignee] = (results.assignedCounts[finalAssignee] || 0) + 1;
    } catch (e) {
      results.skipped++; results.errors.push({ row: i + 1, error: String(e.message || e) });
    }
  }
  return results;
}

async function api_leads_duplicateHistory(token, leadId) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const lead = await db.findById('leads', leadId);
  if (!lead) throw new Error('Not found');
  if (!_isVisible(me, visible, lead)) throw new Error('Forbidden');

  const phone = String(lead.phone || '').replace(/\D/g, '');
  const wa = String(lead.whatsapp || '').replace(/\D/g, '');
  const email = String(lead.email || '').trim().toLowerCase();
  const all = (await db.getAll('leads')).filter(l => {
    if (Number(l.id) === Number(leadId)) return false;
    const lp = String(l.phone || '').replace(/\D/g, '');
    const lw = String(l.whatsapp || '').replace(/\D/g, '');
    const le = String(l.email || '').trim().toLowerCase();
    if (phone && (phone === lp || phone === lw)) return true;
    if (wa && (wa === lp || wa === lw)) return true;
    if (email && email === le) return true;
    return false;
  });
  const { usersById, statusesById, productsById, tatByStatusId, finalStatusIds } = await _lookups();
  const remarks = await db.getAll('remarks');
  return all
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(l => {
      const h = _hydrate(l, usersById, statusesById, productsById, tatByStatusId, finalStatusIds);
      h.remarks = remarks
        .filter(r => Number(r.lead_id) === Number(l.id))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 10);
      return h;
    });
}

/**
 * One-click duplicate a lead and assign the copy to a different sales user.
 * Creates a fresh lead with the same contact info but a status of "New",
 * an empty followup history, and a remark linking back to the original.
 *
 * Args: (token, leadId, newAssigneeId)
 */
async function api_leads_duplicateAndReassign(token, leadId, newAssigneeId) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) {
    throw new Error('Only admin / manager / team leader can duplicate-and-reassign');
  }
  const original = await db.findById('leads', leadId);
  if (!original) throw new Error('Original lead not found');
  if (!newAssigneeId) throw new Error('newAssigneeId required');
  const newUser = await db.findById('users', newAssigneeId);
  if (!newUser) throw new Error('Target user not found');

  // Manual duplicate-and-reassign always lands the new row in "Pending"
  // (auto-created if missing) — same convention the auto-dedup path
  // uses. Reasoning: the new assignee should review the lead before it
  // re-enters the live pipeline; "New" / inheriting the original's
  // status would let the new row jump stages without their input.
  const newStatusId = await _pendingStatusId();
  const now = db.nowIso();
  // Fresh lead — only contact info + attribution carry over. We deliberately
  // DO NOT copy: notes (free-form history), extra_json (stale custom-field
  // values), next_followup_at (the new owner schedules their own), tags
  // (might be stage-specific), qualified flag, or any of the historical
  // remarks / followups / actions / stage_log rows. The new assignee gets
  // a clean slate so they can run their own discovery.
  const newId = await db.insert('leads', {
    name:       original.name,
    phone:      original.phone,
    alt_phone:  original.alt_phone,
    whatsapp:   original.whatsapp,
    email:      original.email,
    source:     original.source,
    source_ref: original.source_ref,
    product_id: original.product_id,
    status_id:  newStatusId || original.status_id,
    assigned_to: Number(newAssigneeId),
    created_by: me.id,
    created_at: now,
    updated_at: now,
    last_status_change_at: now,
    is_duplicate: 0,
    duplicate_of: original.id,             // back-link is fine — read-only
    // Address + attribution carry over (those are about the contact, not
    // the conversation). Everything else is reset.
    address:    original.address, city: original.city, state: original.state,
    pincode:    original.pincode, country: original.country, company: original.company,
    value: original.value, currency: original.currency,
    gclid:          original.gclid          || '',
    gad_campaignid: original.gad_campaignid || '',
    utm_source:     original.utm_source     || '',
    utm_medium:     original.utm_medium     || '',
    utm_campaign:   original.utm_campaign   || '',
    utm_term:       original.utm_term       || '',
    utm_content:    original.utm_content    || ''
    // Intentionally omitted: notes, tags, extra_json, next_followup_at,
    // qualified, qualified_at, qualified_by, last_status_change_at-from-
    // original. Fresh lead, fresh data.
  });

  // Per product owner: the manual "Duplicate & reassign" flow must leave
  // the ORIGINAL lead untouched in the UI — no reassignment trail in the
  // remarks list, no last-touched bump. The duplicate_of FK on the new row
  // is the only persisted backlink, and the activity timeline below covers
  // audit. (Earlier we wrote "Duplicated and reassigned to X" on the
  // original; that was confusing the old assignee and is now removed.)

  // Initialise the new lead's activity timeline + stage log so it shows
  // 'Lead received' as the first event (just like a brand-new lead).
  try {
    const tat = require('./tat');
    await tat.logAction(newId, 'created', me.id, { from_duplicate_of: original.id });
    await db.query(
      `INSERT INTO lead_stage_log (lead_id, from_status_id, to_status_id, user_id) VALUES ($1, $2, $3, $4)`,
      [Number(newId), null, newStatusId || original.status_id || null, me.id]
    );
  } catch (e) { console.warn('[duplicate] tat init failed:', e.message); }

  // Push the new assignee — same SMS-style banner as a fresh lead
  setImmediate(async () => {
    try {
      if (Number(newAssigneeId) !== Number(me.id)) {
        const push = require('./push');
        await push.sendPushToUser(newAssigneeId, {
          title: '🎯 New lead assigned (copy)',
          body:  `${original.name || 'Unknown'}${original.phone ? ' · ' + original.phone : ''}`,
          url:   '/#/leads',
          tag:   'lead-' + newId,
          sticky: true
        });
      }
    } catch (e) { console.warn('[push] dup-reassign push failed:', e.message); }
  });

  return { ok: true, id: newId, original_id: original.id };
}

async function api_whatsapp_send(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.text) throw new Error('text required');
  let to = p.to;
  if (p.lead_id) {
    const l = await db.findById('leads', p.lead_id);
    to = to || l?.whatsapp || l?.phone;
  }
  if (!to) throw new Error('no whatsapp number');

  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  let waId = ''; let status = 'simulated (no WA creds)';
  if (phoneId && accessToken && !accessToken.startsWith('your_')) {
    try {
      const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
      const resp = await (await fetch)(
        `https://graph.facebook.com/v19.0/${phoneId}/messages`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to), type: 'text', text: { body: p.text } })
        }
      );
      const json = await resp.json();
      if (json.messages && json.messages[0]) { waId = json.messages[0].id; status = 'sent'; }
      else status = 'failed: ' + (json.error?.message || JSON.stringify(json));
    } catch (e) { status = 'failed: ' + e.message; }
  }
  await db.insert('whatsapp_messages', {
    lead_id: p.lead_id || '', direction: 'out', from_number: '', to_number: String(to),
    body: p.text, wa_message_id: waId, status
  });
  return { ok: true, status, wa_message_id: waId };
}

module.exports = {
  api_leads_list, api_leads_statusCounts, api_leads_get, api_leads_create, api_leads_update,
  api_leads_addRemark, api_leads_pipeline, api_myFollowups, api_followup_done,
  api_leads_bulkUpdate, api_leads_bulkDelete, api_leads_bulkCreate, api_leads_duplicateHistory,
  api_leads_deleteAllDuplicates, api_leads_duplicateAndReassign,
  api_leads_cleanupJunk,
  api_whatsapp_send
};
