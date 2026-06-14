/**
 * routes/permissions.js — role-based permission matrix
 *
 * Permissions catalog (string keys):
 *   leads.view           scope: self | team | global
 *   leads.create
 *   leads.edit           scope: self | team | global
 *   leads.delete         scope: self | team | global
 *   leads.bulk_edit
 *   leads.export
 *   users.view
 *   users.create
 *   users.edit
 *   users.delete
 *   reports.view
 *   settings.edit
 *   automations.manage
 *   rules.manage
 *   salary.view_team
 *   salary.edit
 *   attendance.view_team
 */
const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

const CATALOG = [
  // ── LEADS ───────────────────────────────────────────────────────────
  { key: 'leads.view',          label: 'Leads — View',                 scoped: true },
  { key: 'leads.create',        label: 'Leads — Create' },
  { key: 'leads.edit',          label: 'Leads — Edit',                 scoped: true },
  { key: 'leads.delete',        label: 'Leads — Delete',               scoped: true },
  { key: 'leads.bulk_edit',     label: 'Leads — Bulk edit' },
  { key: 'leads.reassign_own',  label: 'Leads — Reassign own' },   /* SALES_REASSIGN_PERM_v1 */
  { key: 'leads.export',        label: 'Leads — Export (CSV/Excel)' },
  { key: 'leads.merge',         label: 'Leads — Merge duplicates' },   /* PERMS_v2 */
  { key: 'leads.share',         label: 'Leads — Share with co-owners' },
  { key: 'leads.import',        label: 'Leads — CSV / Sheet import' },
  // ── WHATSAPP ────────────────────────────────────────────────────────
  // WA_PERMS_v1 — granular delegation so Admin can grant Bots/Templates/
  // Broadcasts/KB management without giving full settings.edit.
  { key: 'whatsapp.bots.manage',        label: 'WhatsApp — Manage Bots (AI Bot + Bot Flows)' },
  { key: 'whatsapp.templates.manage',   label: 'WhatsApp — Manage Templates' },
  { key: 'whatsapp.broadcasts.manage',  label: 'WhatsApp — Manage Broadcasts / Campaigns' },
  { key: 'whatsapp.kb.manage',          label: 'WhatsApp — Manage AI Bot Knowledge Base' },
  { key: 'whatsapp.chat.view',          label: 'WhatsApp — View chat inbox' },
  { key: 'whatsapp.chat.send',          label: 'WhatsApp — Send chat messages' },
  // ── USERS ───────────────────────────────────────────────────────────
  { key: 'users.view',          label: 'Users — View' },
  { key: 'users.create',        label: 'Users — Create' },
  { key: 'users.edit',          label: 'Users — Edit' },
  { key: 'users.delete',        label: 'Users — Delete / Deactivate' },
  // ── REPORTS / DASHBOARD ─────────────────────────────────────────────
  { key: 'reports.view',        label: 'Reports — View' },
  { key: 'reports.export',      label: 'Reports — Export (CSV/Excel/PDF)' },
  { key: 'reports.builder',     label: 'Reports — Use Report Builder' },
  { key: 'reports.team_data',   label: 'Reports — See whole team data (else self only)' },
  { key: 'dashboard.team_live_status', label: 'Dashboard — Live Team Status (whole team)' },
  { key: 'dashboard.customize', label: 'Dashboard — Pick widgets / customise' },
  // ── TASKS ───────────────────────────────────────────────────────────
  { key: 'tasks.view',          label: 'Tasks — View',                 scoped: true },
  { key: 'tasks.create',        label: 'Tasks — Create' },
  { key: 'tasks.edit',          label: 'Tasks — Edit / Reassign' },
  { key: 'tasks.complete',      label: 'Tasks — Mark complete' },
  { key: 'tasks.delete',        label: 'Tasks — Delete' },
  // ── QUOTATIONS ──────────────────────────────────────────────────────
  { key: 'quotations.view',     label: 'Quotations — View',            scoped: true },
  { key: 'quotations.create',   label: 'Quotations — Create' },
  { key: 'quotations.edit',     label: 'Quotations — Edit' },
  { key: 'quotations.delete',   label: 'Quotations — Delete' },
  { key: 'quotations.send',     label: 'Quotations — Send by Email / WhatsApp' },
  // ── INVOICING (GST module) ──────────────────────────────────────────
  { key: 'invoicing.view',      label: 'Invoicing — View' },
  { key: 'invoicing.create',    label: 'Invoicing — Create invoices' },
  { key: 'invoicing.edit',      label: 'Invoicing — Edit / Cancel' },
  { key: 'invoicing.payments',  label: 'Invoicing — Record payments' },
  { key: 'invoicing.settings',  label: 'Invoicing — Settings (companies, GST, terms)' },
  // ── PRODUCTS ────────────────────────────────────────────────────────
  { key: 'products.view',       label: 'Products — View' },
  { key: 'products.manage',     label: 'Products — Add / Edit / Delete' },
  // ── CUSTOMERS ───────────────────────────────────────────────────────
  { key: 'customers.view',      label: 'Customers — View' },
  { key: 'customers.manage',    label: 'Customers — Create / Edit / Delete' },
  // ── CAMPAIGNS ───────────────────────────────────────────────────────
  { key: 'campaigns.view',      label: 'Campaigns — View' },
  { key: 'campaigns.manage',    label: 'Campaigns — Create / Edit / Delete' },
  { key: 'campaigns.pull',      label: 'Campaigns — Pull leads to self' },
  { key: 'campaigns.reset',     label: 'Campaigns — Reset campaign' },
  // ── COMPLIANCE ──────────────────────────────────────────────────────
  { key: 'compliance.view',     label: 'Compliance — View violations' },
  { key: 'compliance.manage',   label: 'Compliance — Manage rules' },
  // ── NURTURE (Lead Nurturing) ────────────────────────────────────────
  { key: 'nurture.view',        label: 'Nurturing — View flows + enrolments' },
  { key: 'nurture.manage',      label: 'Nurturing — Create / Edit flows' },
  // ── KNOWLEDGE BASE ──────────────────────────────────────────────────
  { key: 'kb.view',             label: 'Knowledge Base — View' },
  { key: 'kb.manage',           label: 'Knowledge Base — Add / Edit / Delete' },
  // ── CALL RECORDINGS ─────────────────────────────────────────────────
  { key: 'recordings.view',     label: 'Recordings — Listen',          scoped: true },
  { key: 'recordings.delete',   label: 'Recordings — Delete' },
  { key: 'recordings.ai_audit', label: 'Recordings — Run AI Call Audit / Summary' },
  // ── TAT / PROJECT STAGE ─────────────────────────────────────────────
  { key: 'tat.view',            label: 'TAT — View TAT report' },
  { key: 'tat.manage',          label: 'TAT — Manage thresholds' },
  { key: 'stages.view',         label: 'Sale Closure Stage — View' },
  { key: 'stages.manage',       label: 'Sale Closure Stage — Configure' },
  // ── HR / ATTENDANCE / SALARY / LEAVES ───────────────────────────────
  { key: 'attendance.view_team',label: 'Attendance — View team' },
  { key: 'attendance.edit',     label: 'Attendance — Edit (mark on behalf)' },
  { key: 'salary.view_team',    label: 'Salary — View team' },
  { key: 'salary.edit',         label: 'Salary — Edit / Generate payslips' },
  { key: 'leaves.apply',        label: 'Leaves — Apply for leave' },
  { key: 'leaves.approve',      label: 'Leaves — Approve team leaves' },
  { key: 'hr.holidays.manage',  label: 'HR — Manage holidays calendar' },
  { key: 'reimburse.view_team', label: 'Reimbursement — View team' },
  { key: 'reimburse.manage',    label: 'Reimbursement — Configure policy' },
  // ── LOCATION TRACKING ───────────────────────────────────────────────
  { key: 'tracking.view_team',  label: 'Tracking — View team day trail + live map' },
  // ── TARGETS ─────────────────────────────────────────────────────────
  { key: 'targets.view',        label: 'Targets — View',               scoped: true },
  { key: 'targets.manage',      label: 'Targets — Set / Edit' },
  // ── MEETINGS (Google Meet / Calendar) ───────────────────────────────
  { key: 'meetings.create',     label: 'Meetings — Create / Send invite' },
  { key: 'calendar.connect',    label: 'Meetings — Connect own Google Calendar' },
  // ── FACEBOOK / META / SOCIAL ────────────────────────────────────────
  { key: 'social.view',         label: 'Social — View pages + comments' },
  { key: 'social.publish',      label: 'Social — Publish FB / IG posts' },
  { key: 'meta.ads.view',       label: 'Meta Ads — View Ads Manager reports' },
  { key: 'meta.ads.manage',     label: 'Meta Ads — Create / Edit campaigns' },
  // ── COPILOT (✨ Ask CRM) ────────────────────────────────────────────
  { key: 'copilot.use',         label: 'Copilot — Use ✨ Ask CRM widget' },
  { key: 'copilot.actions',     label: 'Copilot — Run write actions (preview/confirm)' },
  { key: 'qnote.use',           label: 'AI Quick Note — Use the ✨ row button' },
  // ── INTEGRATIONS / WEBHOOKS ─────────────────────────────────────────
  { key: 'integrations.view',   label: 'Integrations — View configured sources' },
  { key: 'integrations.manage', label: 'Integrations — Connect / Edit / Disconnect' },
  { key: 'webhooks.manage',     label: 'Webhooks — Manage outbound webhooks' },
  // ── SETTINGS / AUTOMATIONS / RULES ──────────────────────────────────
  { key: 'settings.edit',       label: 'Settings — Edit tenant settings' },
  { key: 'automations.manage',  label: 'Automations — Create / Edit rules' },
  { key: 'rules.manage',        label: 'Auto-assign — Manage rules' },
  // ── PERMISSIONS (admin gate) ────────────────────────────────────────
  { key: 'permissions.manage',  label: 'Permissions — Edit role matrix (admin only)' },
  // ── OPPORTUNITIES_v1 (2026-06-13) — multi-opportunity + multi-pipeline ──
  { key: 'opportunities.view',         label: 'Opportunities — View (own + team)' },
  { key: 'opportunities.view_all',     label: 'Opportunities — View all (org-wide)' },
  { key: 'opportunities.create',       label: 'Opportunities — Create new' },
  { key: 'opportunities.edit',         label: 'Opportunities — Edit existing' },
  { key: 'opportunities.delete',       label: 'Opportunities — Delete' },
  { key: 'opportunities.change_stage', label: 'Opportunities — Change stage' },
  { key: 'opportunities.bulk_edit',    label: 'Opportunities — Bulk actions' },
  { key: 'opportunities.close',        label: 'Opportunities — Close as won/lost' },
  { key: 'pipelines.manage',           label: 'Pipelines — Create / Edit pipelines + stages' },
  { key: 'opportunities.types_manage', label: 'Opportunities — Manage opportunity types' },
  { key: 'opportunities.reports',      label: 'Opportunities — View pipeline reports' },
  // ── LEAD_SCORING_v1 ──
  { key: 'leadScoring.view',          label: 'AI Score — View on leads' },
  { key: 'leadScoring.view_dashboard', label: 'AI Score — View High-Intent Dashboard' },
  { key: 'leadScoring.edit_rules',    label: 'AI Score — Edit rating rules' },
  { key: 'leadScoring.edit_settings', label: 'AI Score — Edit thresholds & SLA' },
  { key: 'leadScoring.override',      label: 'AI Score — Manual category override' },
  { key: 'leadScoring.backfill',      label: 'AI Score — Backfill existing leads' }
];

// Defaults used when no custom matrix is saved
const DEFAULTS = {
  admin: {
    'leads.view': 'global', 'leads.create': 1, 'leads.edit': 'global', 'leads.delete': 'global',
    'leads.bulk_edit': 1, 'leads.export': 1, 'leads.reassign_own': 1,
    'leads.merge': 1, 'leads.share': 1, 'leads.import': 1,
    'whatsapp.bots.manage': 1, 'whatsapp.templates.manage': 1, 'whatsapp.broadcasts.manage': 1, 'whatsapp.kb.manage': 1,
    'whatsapp.chat.view': 1, 'whatsapp.chat.send': 1,
    'users.view': 1, 'users.create': 1, 'users.edit': 1, 'users.delete': 1,
    'reports.view': 1, 'reports.export': 1, 'reports.builder': 1, 'reports.team_data': 1,
    'dashboard.team_live_status': 1, 'dashboard.customize': 1,
    'tasks.view': 'global', 'tasks.create': 1, 'tasks.edit': 1, 'tasks.complete': 1, 'tasks.delete': 1,
    'quotations.view': 'global', 'quotations.create': 1, 'quotations.edit': 1, 'quotations.delete': 1, 'quotations.send': 1,
    'invoicing.view': 1, 'invoicing.create': 1, 'invoicing.edit': 1, 'invoicing.payments': 1, 'invoicing.settings': 1,
    'products.view': 1, 'products.manage': 1,
    'customers.view': 1, 'customers.manage': 1,
    'campaigns.view': 1, 'campaigns.manage': 1, 'campaigns.pull': 1, 'campaigns.reset': 1,
    'compliance.view': 1, 'compliance.manage': 1,
    'nurture.view': 1, 'nurture.manage': 1,
    'kb.view': 1, 'kb.manage': 1,
    'recordings.view': 'global', 'recordings.delete': 1, 'recordings.ai_audit': 1,
    'tat.view': 1, 'tat.manage': 1, 'stages.view': 1, 'stages.manage': 1,
    'attendance.view_team': 1, 'attendance.edit': 1,
    'salary.view_team': 1, 'salary.edit': 1,
    'leaves.apply': 1, 'leaves.approve': 1, 'hr.holidays.manage': 1,
    'reimburse.view_team': 1, 'reimburse.manage': 1,
    'tracking.view_team': 1,
    'targets.view': 'global', 'targets.manage': 1,
    'meetings.create': 1, 'calendar.connect': 1,
    'social.view': 1, 'social.publish': 1, 'meta.ads.view': 1, 'meta.ads.manage': 1,
    'copilot.use': 1, 'copilot.actions': 1, 'qnote.use': 1,
    'integrations.view': 1, 'integrations.manage': 1, 'webhooks.manage': 1,
    'settings.edit': 1, 'automations.manage': 1, 'rules.manage': 1,
    'permissions.manage': 1
  },
  manager: {
    'leads.view': 'team', 'leads.create': 1, 'leads.edit': 'team', 'leads.delete': 'team',
    'leads.bulk_edit': 1, 'leads.export': 1, 'leads.reassign_own': 1,
    'leads.merge': 1, 'leads.share': 1, 'leads.import': 1,
    'whatsapp.bots.manage': 1, 'whatsapp.templates.manage': 1, 'whatsapp.broadcasts.manage': 1, 'whatsapp.kb.manage': 1,
    'whatsapp.chat.view': 1, 'whatsapp.chat.send': 1,
    'users.view': 1, 'users.create': 1, 'users.edit': 1, 'users.delete': 0,
    'reports.view': 1, 'reports.export': 1, 'reports.builder': 1, 'reports.team_data': 1,
    'dashboard.team_live_status': 1, 'dashboard.customize': 1,
    'tasks.view': 'team', 'tasks.create': 1, 'tasks.edit': 1, 'tasks.complete': 1, 'tasks.delete': 0,
    'quotations.view': 'team', 'quotations.create': 1, 'quotations.edit': 1, 'quotations.delete': 0, 'quotations.send': 1,
    'invoicing.view': 1, 'invoicing.create': 1, 'invoicing.edit': 1, 'invoicing.payments': 1, 'invoicing.settings': 0,
    'products.view': 1, 'products.manage': 1,
    'customers.view': 1, 'customers.manage': 1,
    'campaigns.view': 1, 'campaigns.manage': 1, 'campaigns.pull': 1, 'campaigns.reset': 0,
    'compliance.view': 1, 'compliance.manage': 0,
    'nurture.view': 1, 'nurture.manage': 1,
    'kb.view': 1, 'kb.manage': 1,
    'recordings.view': 'team', 'recordings.delete': 0, 'recordings.ai_audit': 1,
    'tat.view': 1, 'tat.manage': 0, 'stages.view': 1, 'stages.manage': 0,
    'attendance.view_team': 1, 'attendance.edit': 1,
    'salary.view_team': 1, 'salary.edit': 0,
    'leaves.apply': 1, 'leaves.approve': 1, 'hr.holidays.manage': 0,
    'reimburse.view_team': 1, 'reimburse.manage': 0,
    'tracking.view_team': 1,
    'targets.view': 'team', 'targets.manage': 1,
    'meetings.create': 1, 'calendar.connect': 1,
    'social.view': 1, 'social.publish': 1, 'meta.ads.view': 1, 'meta.ads.manage': 0,
    'copilot.use': 1, 'copilot.actions': 0, 'qnote.use': 1,
    'integrations.view': 1, 'integrations.manage': 0, 'webhooks.manage': 0,
    'settings.edit': 0, 'automations.manage': 0, 'rules.manage': 1,
    'permissions.manage': 0
  },
  team_leader: {
    'leads.view': 'team', 'leads.create': 1, 'leads.edit': 'team', 'leads.delete': 'self',
    'leads.bulk_edit': 1, 'leads.export': 1, 'leads.reassign_own': 1,
    'leads.merge': 0, 'leads.share': 1, 'leads.import': 0,
    'whatsapp.bots.manage': 0, 'whatsapp.templates.manage': 0, 'whatsapp.broadcasts.manage': 0, 'whatsapp.kb.manage': 0,
    'whatsapp.chat.view': 1, 'whatsapp.chat.send': 1,
    'users.view': 1, 'users.create': 0, 'users.edit': 0, 'users.delete': 0,
    'reports.view': 1, 'reports.export': 1, 'reports.builder': 0, 'reports.team_data': 1,
    'dashboard.team_live_status': 1, 'dashboard.customize': 1,
    'tasks.view': 'team', 'tasks.create': 1, 'tasks.edit': 1, 'tasks.complete': 1, 'tasks.delete': 0,
    'quotations.view': 'team', 'quotations.create': 1, 'quotations.edit': 1, 'quotations.delete': 0, 'quotations.send': 1,
    'invoicing.view': 1, 'invoicing.create': 0, 'invoicing.edit': 0, 'invoicing.payments': 0, 'invoicing.settings': 0,
    'products.view': 1, 'products.manage': 0,
    'customers.view': 1, 'customers.manage': 1,
    'campaigns.view': 1, 'campaigns.manage': 0, 'campaigns.pull': 1, 'campaigns.reset': 0,
    'compliance.view': 1, 'compliance.manage': 0,
    'nurture.view': 1, 'nurture.manage': 0,
    'kb.view': 1, 'kb.manage': 0,
    'recordings.view': 'team', 'recordings.delete': 0, 'recordings.ai_audit': 0,
    'tat.view': 1, 'tat.manage': 0, 'stages.view': 1, 'stages.manage': 0,
    'attendance.view_team': 1, 'attendance.edit': 0,
    'salary.view_team': 0, 'salary.edit': 0,
    'leaves.apply': 1, 'leaves.approve': 1, 'hr.holidays.manage': 0,
    'reimburse.view_team': 0, 'reimburse.manage': 0,
    'tracking.view_team': 1,
    'targets.view': 'team', 'targets.manage': 0,
    'meetings.create': 1, 'calendar.connect': 1,
    'social.view': 0, 'social.publish': 0, 'meta.ads.view': 0, 'meta.ads.manage': 0,
    'copilot.use': 1, 'copilot.actions': 0, 'qnote.use': 1,
    'integrations.view': 0, 'integrations.manage': 0, 'webhooks.manage': 0,
    'settings.edit': 0, 'automations.manage': 0, 'rules.manage': 0,
    'permissions.manage': 0
  },
  sales: {
    'leads.view': 'self', 'leads.create': 1, 'leads.edit': 'self', 'leads.delete': 0,
    'leads.bulk_edit': 0, 'leads.export': 0, 'leads.reassign_own': 0,
    'leads.merge': 0, 'leads.share': 0, 'leads.import': 0,
    'whatsapp.bots.manage': 0, 'whatsapp.templates.manage': 0, 'whatsapp.broadcasts.manage': 0, 'whatsapp.kb.manage': 0,
    'whatsapp.chat.view': 1, 'whatsapp.chat.send': 1,
    'users.view': 0, 'users.create': 0, 'users.edit': 0, 'users.delete': 0,
    'reports.view': 0, 'reports.export': 0, 'reports.builder': 0, 'reports.team_data': 0,
    'dashboard.team_live_status': 0, 'dashboard.customize': 1,
    'tasks.view': 'self', 'tasks.create': 1, 'tasks.edit': 0, 'tasks.complete': 1, 'tasks.delete': 0,
    'quotations.view': 'self', 'quotations.create': 1, 'quotations.edit': 1, 'quotations.delete': 0, 'quotations.send': 1,
    'invoicing.view': 0, 'invoicing.create': 0, 'invoicing.edit': 0, 'invoicing.payments': 0, 'invoicing.settings': 0,
    'products.view': 1, 'products.manage': 0,
    'customers.view': 1, 'customers.manage': 0,
    'campaigns.view': 1, 'campaigns.manage': 0, 'campaigns.pull': 1, 'campaigns.reset': 0,
    'compliance.view': 0, 'compliance.manage': 0,
    'nurture.view': 0, 'nurture.manage': 0,
    'kb.view': 1, 'kb.manage': 0,
    'recordings.view': 'self', 'recordings.delete': 0, 'recordings.ai_audit': 0,
    'tat.view': 0, 'tat.manage': 0, 'stages.view': 0, 'stages.manage': 0,
    'attendance.view_team': 0, 'attendance.edit': 0,
    'salary.view_team': 0, 'salary.edit': 0,
    'leaves.apply': 1, 'leaves.approve': 0, 'hr.holidays.manage': 0,
    'reimburse.view_team': 0, 'reimburse.manage': 0,
    'tracking.view_team': 0,
    'targets.view': 'self', 'targets.manage': 0,
    'meetings.create': 1, 'calendar.connect': 1,
    'social.view': 0, 'social.publish': 0, 'meta.ads.view': 0, 'meta.ads.manage': 0,
    'copilot.use': 1, 'copilot.actions': 0, 'qnote.use': 1,
    'integrations.view': 0, 'integrations.manage': 0, 'webhooks.manage': 0,
    'settings.edit': 0, 'automations.manage': 0, 'rules.manage': 0,
    'permissions.manage': 0
  }
};

async function _matrix() {
  const rows = await db.getAll('role_permissions').catch(() => []);
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  rows.forEach(r => {
    if (!out[r.role]) out[r.role] = {};
    if (Number(r.is_granted) === 0) out[r.role][r.permission] = 0;
    else                            out[r.role][r.permission] = r.scope || 1;
  });
  return out;
}

async function api_permissions_get(token) {
  await authUser(token);
  return { catalog: CATALOG, matrix: await _matrix() };
}

async function api_permissions_save(token, matrix) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  // Upsert each role+permission
  const existing = await db.getAll('role_permissions');
  const byKey = {};
  existing.forEach(r => { byKey[r.role + '|' + r.permission] = r; });
  for (const [role, perms] of Object.entries(matrix || {})) {
    for (const [perm, val] of Object.entries(perms)) {
      const row = byKey[role + '|' + perm];
      const payload = (val && val !== 0)
        ? { is_granted: 1, scope: typeof val === 'string' ? val : null }
        : { is_granted: 0, scope: null };
      if (row) await db.update('role_permissions', row.id, payload);
      else     await db.insert('role_permissions', Object.assign({ role, permission: perm }, payload));
    }
  }
  return { ok: true };
}

async function can(user, permission, opts) {
  if (!user) return false;
  const m = await _matrix();
  const v = m[user.role]?.[permission];
  if (!v) return false;
  if (v === 1) return true;
  // scoped: 'self' | 'team' | 'global' — the route should pass targetUserId+visible to decide
  if (typeof v === 'string' && opts?.scope) return _scopeAllows(v, opts);
  return v; // return the scope string for callers that want it
}

function _scopeAllows(grantedScope, opts) {
  const { targetUserId, actorId, visible } = opts;
  if (grantedScope === 'global') return true;
  if (grantedScope === 'team')   return (visible || []).includes(Number(targetUserId));
  if (grantedScope === 'self')   return Number(targetUserId) === Number(actorId);
  return false;
}

/**
 * teamStatusUserIds(me) — returns the set of user IDs the caller is allowed
 * to see in the Live Team Status widget.
 *
 *   admin (or any role that can() returns truthy for team_live_status
 *   with no explicit revocation) → null  (caller sees ALL active users)
 *
 *   role with dashboard.team_live_status granted → getVisibleUserIds(me)
 *   (manager sees team tree, team_leader sees reports, etc.)
 *
 *   role with permission revoked / not granted → [me.id]  (self only)
 *
 * Returning null instead of "all IDs" lets callers skip a potentially
 * large set comparison for admins.
 */
async function teamStatusUserIds(me) {
  if (!me) return [];
  if (me.role === 'admin') return null; // admin sees all
  try {
    const granted = await can(me, 'dashboard.team_live_status');
    if (granted) {
      const ids = await getVisibleUserIds(me);
      return ids.map(Number);
    }
  } catch (_) { /* fall through to self-only */ }
  return [Number(me.id)];
}

module.exports = { api_permissions_get, api_permissions_save, can, CATALOG, DEFAULTS, teamStatusUserIds };
