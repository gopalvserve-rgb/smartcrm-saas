const db = require('../db/pg');
const { authUser, hashPassword, getVisibleUserIds } = require('../utils/auth');

async function api_users_list(token) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const all = await db.getAll('users');
  const byId = {};
  all.forEach(u => { byId[Number(u.id)] = u; });
  return all
    .filter(u => visible.includes(Number(u.id)))
    .map(u => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone,
      role: u.role, parent_id: u.parent_id,
      parent_name: byId[Number(u.parent_id)]?.name || '',
      department: u.department, monthly_salary: u.monthly_salary,
      joining_date: u.joining_date, photo_url: u.photo_url,
      is_active: u.is_active, created_at: u.created_at,
      daily_lead_cap:   Number(u.daily_lead_cap)   || 0,
      monthly_lead_cap: Number(u.monthly_lead_cap) || 0,
      calendly_url: u.calendly_url || '',
      autodial_on: Number(u.autodial_on != null ? u.autodial_on : 1) ? 1 : 0
    }));
}

async function api_users_create(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const p = payload || {};
  if (!p.name || !p.email || !p.password || !p.role) throw new Error('name, email, password, role required');
  if (await db.findOneBy('users', 'email', String(p.email).toLowerCase().trim())) {
    throw new Error('Email already registered');
  }
  const id = await db.insert('users', {
    name: p.name,
    email: String(p.email).toLowerCase().trim(),
    phone: p.phone || '',
    password_hash: hashPassword(p.password),
    role: p.role,
    parent_id: p.parent_id || me.id,
    department: p.department || '',
    designation: p.designation || '',
    monthly_salary: p.monthly_salary || 0,
    joining_date: p.joining_date || '',
    photo_url: p.photo_url || '',
    // HR / onboarding fields — all optional, captured at creation time
    father_name:             p.father_name             || '',
    personal_email:          p.personal_email          || '',
    address:                 p.address                 || '',
    aadhaar_number:          p.aadhaar_number          || '',
    pan_number:              p.pan_number              || '',
    last_company:            p.last_company            || '',
    emergency_contact_name:  p.emergency_contact_name  || '',
    emergency_contact_phone: p.emergency_contact_phone || '',
    reference_1_name:        p.reference_1_name        || '',
    reference_1_phone:       p.reference_1_phone       || '',
    reference_1_relation:    p.reference_1_relation    || '',
    reference_2_name:        p.reference_2_name        || '',
    reference_2_phone:       p.reference_2_phone       || '',
    reference_2_relation:    p.reference_2_relation    || '',
    daily_lead_cap:          Math.max(0, Number(p.daily_lead_cap)   || 0),
    monthly_lead_cap:        Math.max(0, Number(p.monthly_lead_cap) || 0),
    is_active: 1
  });
  return { id };
}

async function api_users_update(token, id, patch) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role) && Number(me.id) !== Number(id)) {
    throw new Error('Forbidden');
  }
  const p = patch || {};
  const allowed = {};
  // Standard fields any user can update on themselves (and admins/managers on others)
  ['name', 'phone', 'department', 'designation', 'monthly_salary', 'joining_date', 'photo_url', 'is_active',
   // HR / onboarding fields
   'father_name', 'personal_email', 'address', 'aadhaar_number', 'pan_number', 'last_company',
   'emergency_contact_name', 'emergency_contact_phone',
   'reference_1_name', 'reference_1_phone', 'reference_1_relation',
   'reference_2_name', 'reference_2_phone', 'reference_2_relation',
   // Scheduling
   'calendly_url',
   // Auto-dial preference (each rep can opt in/out for themselves)
   'autodial_on'
  ].forEach(k => {
    if (k in p) {
      allowed[k] = (k === 'autodial_on') ? (p[k] ? 1 : 0) : p[k];
    }
  });
  // Email — needs uniqueness check against other users (case-insensitive)
  if ('email' in p) {
    const newEmail = String(p.email || '').toLowerCase().trim();
    if (!newEmail) throw new Error('Email cannot be empty');
    const existing = await db.findOneBy('users', 'email', newEmail);
    if (existing && Number(existing.id) !== Number(id)) {
      throw new Error('Another user is already using that email address');
    }
    allowed.email = newEmail;
  }
  if (['admin', 'manager'].includes(me.role)) {
    if ('role' in p) allowed.role = p.role;
    if ('parent_id' in p) allowed.parent_id = p.parent_id;
    // Lead capping — only admins/managers can set someone else's caps.
    // Self-edit isn't allowed via this path (users shouldn't relax
    // their own caps).
    if ('daily_lead_cap' in p)   allowed.daily_lead_cap   = Math.max(0, Number(p.daily_lead_cap)   || 0);
    if ('monthly_lead_cap' in p) allowed.monthly_lead_cap = Math.max(0, Number(p.monthly_lead_cap) || 0);
  }
  if (p.password) allowed.password_hash = hashPassword(p.password);
  await db.update('users', id, allowed);
  return { ok: true };
}

async function api_users_updateSelf(token, patch) {
  const me = await authUser(token);
  const allowed = {};
  ['name', 'phone', 'photo_url', 'calendly_url', 'autodial_on'].forEach(k => {
    if (k in patch) {
      allowed[k] = (k === 'autodial_on') ? (patch[k] ? 1 : 0) : patch[k];
    }
  });
  await db.update('users', me.id, allowed);
  return { ok: true };
}

// Convenience: create if no id, update otherwise
async function api_users_save(token, payload) {
  if (payload && payload.id) {
    const { id, ...patch } = payload;
    return api_users_update(token, id, patch);
  }
  return api_users_create(token, payload);
}

/**
 * Generate a friendly-looking but secure-enough random password.
 * 12 chars, mixed case + digits + a small punctuation set, with at least
 * one of each so it doesn't collide with strict policies on first login.
 */
function _generateTempPassword() {
  const upper  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // omit I, O for readability
  const lower  = 'abcdefghijkmnpqrstuvwxyz';   // omit l, o
  const digits = '23456789';                   // omit 0, 1
  const punct  = '@#$%&*';
  const all = upper + lower + digits + punct;
  const pick = (set) => set[Math.floor(Math.random() * set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(punct)];
  while (chars.length < 12) chars.push(pick(all));
  // Shuffle so the guaranteed types aren't always at the start
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Admin / manager: reset any visible user's password.
 *   - Admin can reset anyone (including other admins) except their own active session targets — but they can also reset themselves.
 *   - Manager can reset only users in their hierarchy (per getVisibleUserIds).
 *   - team_leader / sales / employee: forbidden.
 *
 * Pass `newPassword` to set a specific value; pass empty/null to auto-generate.
 * Returns `{ password: '<plaintext>' }` so the admin can copy & share it. The
 * plaintext is never logged or stored — the DB only sees the bcrypt hash.
 */
async function api_users_resetPassword(token, userId, newPassword) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) {
    throw new Error('Only admins or managers can reset passwords');
  }
  const target = await db.findById('users', userId);
  if (!target) throw new Error('User not found');

  // Managers can only reset users below them in the hierarchy.
  if (me.role === 'manager') {
    const visible = await getVisibleUserIds(me);
    if (!visible.includes(Number(target.id))) {
      throw new Error('Forbidden — user is outside your team');
    }
    // Managers must not reset other admins/managers — only people they manage.
    if (['admin', 'manager'].includes(target.role) && Number(target.id) !== Number(me.id)) {
      throw new Error('Forbidden — managers cannot reset other admins/managers');
    }
  }

  // Use the supplied password if it looks usable; otherwise generate a fresh one.
  const trimmed = String(newPassword || '').trim();
  const plain = trimmed.length >= 6 ? trimmed : _generateTempPassword();
  await db.update('users', userId, { password_hash: hashPassword(plain) });
  return { password: plain };
}

/**
 * Hard-delete a user with safety checks. Reassigns their leads to the caller
 * (or to the org's first admin) so the data isn't orphaned.
 *
 * Guards:
 *   - Admin only — managers can't delete other admins/managers, and we don't
 *     want manager-level access to permanently remove team members.
 *   - Cannot delete yourself.
 *   - Cannot delete the last active admin (would lock you out of the system).
 */
async function api_users_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Only admins can delete users');
  const target = await db.findById('users', id);
  if (!target) throw new Error('User not found');
  if (Number(target.id) === Number(me.id)) throw new Error('You cannot delete your own account');
  if (target.role === 'admin') {
    const admins = (await db.getAll('users')).filter(u => u.role === 'admin' && Number(u.is_active) === 1);
    if (admins.length <= 1) {
      throw new Error('Cannot delete the only remaining admin — promote another user first');
    }
  }

  // Reassign every record this user owns so we don't leave dangling foreign keys.
  // Lead reassignment goes to the deleting admin so visibility is preserved.
  // For other tables we just clear the reference (set NULL where allowed).
  const reassign = async (table, column, newValue) => {
    try {
      await db.query(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
        [newValue, target.id]
      );
    } catch (e) {
      // If the column doesn't exist on this deployment it's fine — skip silently.
      if (!/column .* does not exist/i.test(String(e.message || ''))) {
        console.warn(`[delete user] reassign ${table}.${column} failed:`, e.message);
      }
    }
  };
  await reassign('leads', 'assigned_to', me.id);
  await reassign('leads', 'created_by', me.id);
  await reassign('remarks', 'user_id', null);
  await reassign('lead_recordings', 'user_id', null);
  await reassign('notifications', 'user_id', null);
  await reassign('tasks', 'assigned_to', me.id);
  await reassign('tasks', 'created_by', me.id);

  // Now safe to hard-delete the user row.
  await db.removeRow('users', target.id);
  return { ok: true, id: Number(target.id), reassigned_to: me.id };
}

/**
 * Get the current user's Calendly webhook URL. Generates a token
 * lazily on first call so existing users don't need a migration.
 */
async function api_users_calendlyWebhook(token) {
  const me = await authUser(token);
  let t = me.calendly_webhook_token;
  if (!t) {
    const crypto = require('crypto');
    t = 'cal_' + crypto.randomBytes(20).toString('hex');
    await db.update('users', me.id, { calendly_webhook_token: t });
  }
  return { token: t };
}

/**
 * Generate a fresh Calendly webhook token for the current user.
 * Use this if the existing one was leaked or compromised.
 */
async function api_users_regenerateCalendlyWebhook(token) {
  const me = await authUser(token);
  const crypto = require('crypto');
  const t = 'cal_' + crypto.randomBytes(20).toString('hex');
  await db.update('users', me.id, { calendly_webhook_token: t });
  return { token: t };
}

module.exports = {
  api_users_list, api_users_create, api_users_update,
  api_users_updateSelf, api_users_save, api_users_resetPassword,
  api_users_delete,
  api_users_calendlyWebhook, api_users_regenerateCalendlyWebhook
};
