/**
 * utils/moduleCatalog.js
 *
 * Single source of truth for the platform's module list. Each module
 * groups one or more SPA nav items, settings sub-tabs, and (optionally)
 * api_* endpoints. Super-admin toggles modules ON/OFF per tenant from
 * the Tenants page; the tenant SPA filters its sidebar + Settings rail
 * to only show enabled modules.
 *
 * Schema:
 *   key:           short stable id stored in the per-tenant flag
 *   label:         shown in the super-admin toggle UI
 *   description:   one-line hint shown next to the toggle
 *   nav_ids:       SPA nav.item ids that belong to this module
 *   settings_ids:  Settings sub-tab ids that belong to this module
 *   api_prefixes:  api_* function prefixes — used for hard backend
 *                  enforcement (a 403 if module is off and someone
 *                  bypasses the SPA)
 *   default_on:    if true, enabled by default for any tenant whose
 *                  modules_json is NULL / empty (i.e. before super-admin
 *                  has touched it)
 *   always_on:     true means the toggle is hidden in the UI — it can
 *                  never be turned off (Company branding, Users, etc.)
 *
 * Adding a new module: append to MODULE_CATALOG and tag the relevant
 * NAV_GROUPS items with `module: '<key>'` in public/tenant/app.js.
 */

'use strict';

const MODULE_CATALOG = [
  { key: 'leads',      label: '🎯 Leads',          description: 'Leads list, Pipeline, Kanban, Follow-ups, Calendar, Monthly target, plus Sources / Statuses / Custom Fields / Tags / Auto-assign / Duplicates / Lead Pull / TAT.',
    nav_ids:      ['leads','pipeline','kanban','followups','calendar','target','newleads','overdue','duetoday','upcoming'],
    settings_ids: ['sources','statuses','customfields','tags','rules','duplicates','tat','pullleads','automations','projstages'],
    api_prefixes: ['api_leads_','api_sources_','api_statuses_','api_customFields_','api_tags_','api_rules_','api_tat_','api_projectStages_'],
    default_on: true,  always_on: false },

  { key: 'calls',      label: '📞 Calls',          description: 'Dialer, call insights, call ratings, AI usage, recording sync.',
    nav_ids:      ['dialer','callinsights','callratings','aiusage'],
    settings_ids: [],
    api_prefixes: ['api_call_','api_recording_','api_recordings_'],
    default_on: true,  always_on: false },

  { key: 'catalog',    label: '📦 Catalog',        description: 'Inventory, Projects, Products.',
    nav_ids:      ['inventory','projects'],
    settings_ids: ['products'],
    api_prefixes: ['api_products_','api_inventory_'],
    default_on: true,  always_on: false },

  { key: 'reports',    label: '📊 Reports',        description: 'Reports, Report builder, TAT report.',
    nav_ids:      ['reports','reportbuilder','tatreport'],
    settings_ids: [],
    api_prefixes: ['api_reports_'],
    default_on: true,  always_on: false },

  { key: 'whatsbot',   label: '💬 WhatsBot',       description: 'WhatsApp chat + templates + bots + campaigns + multi-number.',
    nav_ids:      ['whatsbot'],
    settings_ids: ['whatsapp'],
    api_prefixes: ['api_wb_','api_wa_phones_','api_whatsapp_'],
    default_on: true,  always_on: false },

  { key: 'aibot',      label: '🤖 AI Bot',         description: 'Per-tenant Gemini-powered WhatsApp AI assistant.',
    nav_ids:      ['aibot'],
    settings_ids: [],
    api_prefixes: ['api_aibot_'],
    default_on: true,  always_on: false },

  { key: 'quotations', label: '📄 Quotations',     description: 'Author quotations and send via email + WhatsApp.',
    nav_ids:      ['quotations'],
    settings_ids: [],
    api_prefixes: ['api_quotations_'],
    default_on: true,  always_on: false },

  { key: 'campaigns',  label: '🎯 Campaigns',      description: 'Lead distribution campaigns + agent rules.',
    nav_ids:      [],
    settings_ids: ['campaigns'],
    api_prefixes: ['api_campaigns_'],
    default_on: true,  always_on: false },

  { key: 'knowledge',  label: '📚 Knowledge',      description: 'Internal knowledge base.',
    nav_ids:      ['knowledge'],
    settings_ids: [],
    api_prefixes: ['api_knowledgeBase_'],
    default_on: true,  always_on: false },

  { key: 'teamchat',   label: '👥 Team chat',      description: 'Internal team chat.',
    nav_ids:      ['teamchat'],
    settings_ids: ['chatperm'],
    api_prefixes: ['api_chat_'],
    default_on: true,  always_on: false },

  { key: 'hr',         label: '🕒 HR & Me',         description: 'Tasks, Attendance, Leaves, Salary, Bank.',
    nav_ids:      ['tasks','attendance','leaves','salary','bank'],
    settings_ids: [],
    api_prefixes: ['api_hr_'],
    default_on: true,  always_on: false },

  { key: 'integrations', label: '🔌 Integrations', description: 'Facebook, third-party sources.',
    nav_ids:      [],
    settings_ids: ['fb','integrations'],
    api_prefixes: ['api_fb_','api_integrations_'],
    default_on: true,  always_on: false },

  // ---- Accounts / GST Invoicing (opt-in) ----------------------------
  // Full GST-compliant invoicing module ported from the Apps Script
  // single-tenant tool. Lives under the "Accounts" group in the tenant
  // SPA sidebar. OPT-IN: tenants do NOT get it by default; super-admin
  // toggles it on per tenant from /admin → Tenants → Modules.
  { key: 'invoicing',  label: '🧾 Accounts (GST Invoicing)',
    description: 'GST-compliant invoicing: sellers, customers, items, invoices, payments, PDF, GSTR-1 export.',
    nav_ids:      ['invDashboard','invList','invCompanies','invCustomers','invItems','invGstr1','invSettings'],
    settings_ids: ['invoicing'],
    api_prefixes: ['api_invoicing_'],
    default_on: false,  always_on: false },

  // Always-on core — branding + users + roles. Toggle hidden in UI.
  { key: 'core',       label: '⚙️ Core (always on)', description: 'Company branding, theme, users, roles, permissions, dashboard.',
    nav_ids:      ['dashboard','users','admin'],
    settings_ids: ['company','api','smtp','announce','roles','permissions','menu','menuorder','dangerzone'],
    api_prefixes: ['api_admin_','api_users_','api_roles_','api_permissions_','api_dashboard_','api_setup_','api_login','api_auth_'],
    default_on: true,  always_on: true },
];

/**
 * Resolve which module keys are active for a tenant.
 *
 * Inputs:
 *   tenantRow.modules_json — JSONB on control.tenants. Contract:
 *     null / undefined / '[]'  → all default_on modules enabled
 *     ['leads','calls',…]      → ONLY these enabled (always_on still on)
 *
 * Always-on modules are forced into the result regardless of what's
 * stored, so the SaaS owner can never accidentally lock themselves out
 * of branding / users / settings.
 */
function resolveModules(tenantRow) {
  let stored = tenantRow && tenantRow.modules_json;
  if (typeof stored === 'string') {
    try { stored = JSON.parse(stored); } catch (_) { stored = null; }
  }
  const useExplicit = Array.isArray(stored) && stored.length > 0;
  const out = new Set();
  for (const m of MODULE_CATALOG) {
    if (m.always_on) { out.add(m.key); continue; }
    if (useExplicit) {
      if (stored.includes(m.key)) out.add(m.key);
    } else if (m.default_on) {
      out.add(m.key);
    }
  }
  return [...out];
}

module.exports = { MODULE_CATALOG, resolveModules };
