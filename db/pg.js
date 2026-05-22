// PostgreSQL adapter. Exposes the same API as the previous Sheets adapter
// so route files don't need to change:
//   getAll(table), findById(table, id), findOneBy(table, field, value),
//   findBy(table, field, value), insert(table, row), update(table, id, patch),
//   removeRow(table, id), nowIso()
//
// MULTI-TENANT NOTE: in the SaaS deployment we run with one Postgres
// cluster but a separate database per tenant (tenant_<slug>). The route
// files don't know about tenants — they just call query() / getAll() /
// insert() etc. To make each request hit the correct tenant DB without
// rewriting every route, we use Node's AsyncLocalStorage:
//
//   server.js wraps each tenant request in tenantStorage.run({ pool })
//   below, so any query() call running inside that async chain transparently
//   uses the per-tenant pg.Pool. Outside that chain (single-tenant
//   deployments, control-plane scripts, boot-time migrations) we fall
//   back to the global pool keyed by DATABASE_URL.

const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// Exported so server.js can call tenantStorage.run({ pool }, fn) to
// scope the next async chain to a specific tenant pool.
const tenantStorage = new AsyncLocalStorage();

// IMPORTANT — return date/time columns as ISO strings, not Date objects.
//
// node-pg's default behaviour is to wrap TIMESTAMP/TIMESTAMPTZ/DATE columns in
// JavaScript Date objects. That broke our reports filters because the rest of
// the codebase relies on `String(row.created_at).slice(0, 10)` returning a
// "YYYY-MM-DD" prefix — for a Date object that yields "Sat Apr 26" instead,
// silently returning empty results from any date filter.
//
// Type OIDs:
//   1082  DATE          -> "YYYY-MM-DD"
//   1083  TIME
//   1114  TIMESTAMP     (without TZ)
//   1184  TIMESTAMPTZ   (with TZ)
// We override TIMESTAMP/TIMESTAMPTZ to return the raw ISO-ish text and DATE
// to return the YYYY-MM-DD slice. Strings are still cheaply Date-wrappable
// downstream (`new Date(str)`), so existing math like
// `(new Date(check_out) - new Date(check_in)) / 3600000` keeps working.
function _toIsoString(v) {
  if (v == null) return v;
  // Postgres serialises tz timestamps as e.g. "2026-04-26 12:30:00.000+00".
  // new Date() parses that fine; .toISOString() gives "2026-04-26T12:30:00.000Z"
  // which slices cleanly to YYYY-MM-DD and string-compares correctly.
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}
types.setTypeParser(1184, _toIsoString); // timestamptz
types.setTypeParser(1114, _toIsoString); // timestamp (no tz)
types.setTypeParser(1082, v => v);       // date — already "YYYY-MM-DD"

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[db/pg] WARNING: DATABASE_URL is not set.');
}

const ssl =
  String(process.env.DB_SSL || '').toLowerCase() === '1' ||
  /\b(supabase|neon|render|railway|heroku|aws)\b/i.test(connectionString || '')
    ? { rejectUnauthorized: false }
    : false;

const pool = new Pool({
  connectionString,
  ssl,
  // POOL_EVICT_v1: lowered control pool max from 10 to 5 since per-tenant pools (utils/tenantPool.js) carry their own connections — combined max keeps us under PG max_connections.
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

pool.on('error', (err) => {
  console.error('[db/pg] Unexpected pool error:', err);
});

// -------------------------------------------------------------------
// Known tables and their columns. Used for safe INSERT/UPDATE builders.
// The `id` column is SERIAL on every table.
// JSONB columns are auto-serialized from JS objects.
// -------------------------------------------------------------------
const SCHEMA = {
  users: {
    columns: ['name', 'email', 'phone', 'role', 'password_hash', 'parent_id',
              'department', 'designation', 'photo_url',
              'monthly_salary', 'joining_date',
              'father_name', 'personal_email', 'address',
              'aadhaar_number', 'pan_number', 'last_company',
              'emergency_contact_name', 'emergency_contact_phone',
              'reference_1_name', 'reference_1_phone', 'reference_1_relation',
              'reference_2_name', 'reference_2_phone', 'reference_2_relation',
              'is_active', 'created_at',
              'totp_secret', 'totp_enabled', 'totp_verified_at',
              'daily_lead_cap', 'monthly_lead_cap',
              'calendly_url', 'calendly_webhook_token',
              'paused_for_leads'],
    json: []
  },
  leads: {
    columns: ['gclid', 'gad_campaignid', 'utm_source', 'utm_medium',
              'utm_campaign', 'utm_term', 'utm_content',
              'name', 'phone', 'alt_phone', 'whatsapp', 'email', 'source',
              'source_ref', 'product', 'product_id', 'status_id', 'assigned_to',
              'created_by', 'created_at', 'updated_at',
              'last_status_change_at', 'next_followup_at',
              'is_duplicate', 'duplicate_of', 'tags', 'notes',
              'address', 'city', 'state', 'pincode', 'country', 'company',
              'value', 'currency', 'meta_json', 'extra_json',
              'budget_max', 'requirement_type', 'requirement_notes',
              'project_stage_id', 'project_stage_started_at'],
    json: ['meta_json', 'extra_json']
  },
  project_stages: {
    columns: ['name', 'description', 'sort_order', 'expected_days',
              'assignee_role', 'is_active'],
    json: []
  },
  inventory: {
    columns: ['name', 'item_type', 'price', 'status', 'location',
              'description', 'attributes',
              'created_by', 'created_at', 'updated_at'],
    json: ['attributes']
  },
  personal_wa_templates: {
    columns: ['owner_id', 'name', 'body', 'is_active', 'created_at'],
    json: []
  },
  sheet_integrations: {
    columns: ['name', 'sheet_id', 'sheet_gid', 'default_source',
              'default_assignee_id', 'poll_interval_min',
              'last_synced_at', 'last_synced_count', 'last_error',
              'is_active', 'created_by', 'created_at',
              'webhook_token'],
    json: []
  },
  sheet_imported_rows: {
    columns: ['integration_id', 'row_hash', 'imported_at', 'lead_id'],
    json: []
  },
  remarks: {
    columns: ['lead_id', 'user_id', 'remark', 'status_id', 'created_at'],
    json: []
  },
  followups: {
    columns: ['lead_id', 'user_id', 'due_at', 'note', 'is_done',
              'created_at', 'done_at'],
    json: []
  },
  statuses: {
    columns: ['name', 'color', 'sort_order', 'is_final'],
    json: []
  },
  roles: {
    columns: ['key', 'label', 'hierarchy_level', 'is_system', 'is_active', 'created_at'],
    json: []
  },
  sources: {
    columns: ['name', 'is_active'],
    json: []
  },
  products: {
    columns: ['name', 'description', 'price', 'is_active', 'gst_pct', 'image_url'],
    json: []
  },
  custom_fields: {
    columns: ['key', 'label', 'field_type', 'options', 'is_required',
              'show_in_list', 'sort_order', 'is_active'],
    json: []
  },
  assignment_rules: {
    columns: ['name', 'field', 'operator', 'value', 'assigned_to',
              'priority', 'is_active'],
    json: []
  },
  notifications: {
    columns: ['user_id', 'type', 'title', 'body', 'link', 'is_read',
              'created_at'],
    json: []
  },
  attendance: {
    columns: ['user_id', 'date', 'check_in', 'check_out',
              'check_in_lat', 'check_in_lng', 'check_out_lat', 'check_out_lng',
              'check_in_location_name', 'check_out_location_name',
              'work_mode', 'status', 'notes',
              'device_info', 'user_agent', 'ip'],
    json: []
  },
  // v18: Periodic location pings (every 30 min while user is checked in)
  location_pings: {
    columns: ['user_id', 'attendance_id', 'lat', 'lng',
              'location_name', 'accuracy_m', 'created_at'],
    json: []
  },
  leaves: {
    columns: ['user_id', 'from_date', 'to_date', 'reason', 'status',
              'approved_by', 'created_at'],
    json: []
  },
  tasks: {
    columns: ['title', 'description', 'assigned_to', 'created_by',
              'due_at', 'priority', 'status', 'created_at', 'completed_at'],
    json: []
  },
  salaries: {
    columns: ['user_id', 'month', 'base', 'allowances', 'deductions',
              'net_pay', 'notes', 'created_at'],
    json: []
  },
  bank_details: {
    columns: ['user_id', 'bank_name', 'account_holder', 'account_number',
              'ifsc', 'branch', 'upi_id', 'notes', 'updated_at'],
    json: []
  },
  config: {
    columns: ['key', 'value', 'updated_at'],
    json: []
  },
  webhook_log: {
    columns: ['source', 'payload', 'received_at', 'processed', 'error'],
    json: ['payload']
  },
  whatsapp_messages: {
    columns: ['lead_id', 'user_id', 'direction', 'from_number', 'to_number',
              'body', 'wa_message_id', 'status', 'message_type',
              'media_url', 'media_id', 'reply_to', 'read_at', 'delivered_at',
              'error_text', 'template_name', 'created_at'],
    json: []
  },
  wa_attachments: {
    columns: ['user_id', 'filename', 'mime_type', 'size_bytes', 'bytes',
              'wa_media_id', 'created_at'],
    json: []
  },
  wa_chat_assignments: {
    columns: ['phone', 'assigned_to', 'assigned_by', 'assigned_at', 'note'],
    json: []
  },
  wa_chat_assignment_log: {
    columns: ['phone', 'assigned_to', 'assigned_by', 'note', 'created_at'],
    json: []
  },
  automations: {
    columns: ['name', 'event', 'condition', 'channel', 'recipient',
              'subject', 'template', 'is_active', 'created_at'],
    json: []
  },
  automation_log: {
    columns: ['automation_id', 'lead_id', 'event', 'channel',
              'recipient', 'status', 'detail', 'created_at'],
    json: []
  },
  role_permissions: {
    columns: ['role', 'permission', 'scope', 'is_granted'],
    json: []
  },
  lead_recordings: {
    columns: ['lead_id', 'user_id', 'phone', 'direction', 'duration_s',
              'device_path', 'mime_type', 'size_bytes', 'audio_bytes',
              'started_at', 'created_at',
              'transcript', 'summary', 'action_items', 'sentiment',
              'suggested_status_id', 'next_followup_days', 'key_insight',
              'ai_processed_at', 'ai_provider', 'ai_model', 'ai_error',
              'rating', 'rating_by', 'rating_notes', 'rated_at',
              'ai_suggested_rating',
              'ai_input_tokens', 'ai_output_tokens', 'ai_cost_usd', 'ai_cost_inr'],
    json: []
  },
  call_events: {
    columns: ['lead_id', 'user_id', 'phone', 'direction', 'event',
              'duration_s', 'recording_id', 'created_at'],
    json: []
  },
  email_templates: {
    columns: ['event_type', 'name', 'subject', 'body_html', 'is_active', 'updated_at'],
    json: []
  },
  user_devices: {
    columns: ['user_id', 'fingerprint', 'user_agent', 'ip',
              'first_seen_at', 'last_seen_at'],
    json: []
  },
  // v9: Web Push subscriptions (browser/PWA)
  push_subscriptions: {
    columns: ['user_id', 'endpoint', 'p256dh', 'auth', 'ua', 'created_at'],
    json: []
  },
  // v9: FCM tokens for the Android Capacitor app
  fcm_tokens: {
    columns: ['user_id', 'token', 'platform', 'ua', 'created_at'],
    json: []
  },
  // v10: admin-managed tag library
  tag_library: {
    columns: ['name', 'color', 'is_active', 'created_at'],
    json: []
  },
  // v11: TAT — stage transitions log
  lead_stage_log: {
    columns: ['lead_id', 'from_status_id', 'to_status_id', 'user_id',
              'duration_s', 'created_at'],
    json: []
  },
  // v11: TAT — every action timeline event per lead
  lead_actions: {
    columns: ['lead_id', 'action_type', 'user_id', 'meta_json', 'created_at'],
    json: ['meta_json']
  },
  // v11: TAT — admin per-stage thresholds
  tat_thresholds: {
    columns: ['status_id', 'threshold_minutes', 'is_active', 'updated_at'],
    json: []
  },
  // v11: TAT — open/closed violation rows
  tat_violations: {
    columns: ['lead_id', 'status_id', 'user_id', 'threshold_minutes',
              'triggered_at', 'resolved_at', 'escalation_level',
              'last_escalated_at', 'notes'],
    json: []
  },
  // v12: WhatsBot — cached approved templates from Meta
  wa_templates: {
    columns: ['name', 'language', 'status', 'category', 'body_text',
              'components_json', 'body_params', 'header_type', 'has_buttons',
              'refreshed_at'],
    json: ['components_json']
  },
  // v12: WhatsBot — outbound campaigns
  wa_campaigns: {
    columns: ['name', 'relation_type', 'template_name', 'template_language',
              'variables_json', 'image_url', 'filter_json',
              'scheduled_at', 'send_now', 'status',
              'recipients_total', 'recipients_sent', 'recipients_failed',
              'recipients_delivered', 'recipients_read',
              'created_by', 'created_at', 'started_at', 'completed_at'],
    json: ['variables_json', 'filter_json']
  },
  // v12: WhatsBot — per-recipient send rows
  wa_campaign_targets: {
    columns: ['campaign_id', 'lead_id', 'phone', 'name', 'rendered_message',
              'status', 'wa_message_id', 'error',
              'sent_at', 'delivered_at', 'read_at', 'created_at'],
    json: []
  },
  // v12: WhatsBot — keyword → text reply
  wa_message_bots: {
    columns: ['name', 'relation_type', 'reply_text', 'reply_type',
              'trigger_text', 'header', 'footer',
              'buttons_json', 'cta_button_json', 'image_url',
              'is_active', 'created_at'],
    json: ['buttons_json', 'cta_button_json']
  },
  // v12: WhatsBot — keyword → template reply
  wa_template_bots: {
    columns: ['name', 'relation_type', 'template_name', 'template_language',
              'variables_json', 'reply_type', 'trigger_text',
              'is_active', 'created_at'],
    json: ['variables_json']
  },
  // v12: WhatsBot — activity log
  wa_activity_log: {
    columns: ['category', 'name', 'template_name', 'response_code', 'type',
              'request_json', 'response_json', 'recorded_on'],
    json: ['request_json', 'response_json']
  },
  // v15: Knowledge base — admin-curated reference content for the team
  knowledge_base: {
    columns: ['title', 'category', 'body', 'url', 'tags', 'product_id',
              'is_pinned', 'is_active', 'created_by', 'created_at', 'updated_at'],
    json: []
  },
  // v16: Announcements — top-of-screen banner posted by admin
  announcements: {
    columns: ['title', 'body', 'severity', 'is_active', 'is_dismissible',
              'expires_at', 'created_by', 'created_at'],
    json: []
  },
  announcement_dismissals: {
    columns: ['user_id', 'announcement_id', 'dismissed_at'],
    json: []
  },
  // v17: Internal team chat
  chat_rooms: {
    columns: ['type', 'name', 'created_at'],
    json: []
  },
  chat_room_members: {
    columns: ['room_id', 'user_id', 'last_read_at', 'joined_at'],
    json: []
  },
  chat_messages: {
    columns: ['room_id', 'user_id', 'body', 'created_at'],
    json: []
  },
  saved_filters: {
    columns: ['user_id', 'name', 'view', 'filter_json', 'is_shared', 'created_at'],
    json: ['filter_json']
  },
  customers: {
    columns: [
      'from_lead_id', 'name', 'phone', 'alt_phone', 'whatsapp', 'email', 'pan',
      'date_of_birth', 'gender', 'occupation', 'income_range', 'risk_profile',
      'address', 'city', 'state', 'pincode', 'country', 'company',
      'customer_since', 'status', 'tags', 'notes', 'assigned_to',
      'lifetime_value', 'total_purchases', 'last_purchase_at', 'next_renewal_at',
      'extra_json', 'created_by', 'created_at', 'updated_at'
    ],
    json: ['extra_json']
  },
  customer_sales: {
    columns: [
      'customer_id', 'product_id', 'product_name', 'sale_type', 'sold_at',
      'sold_by', 'amount', 'currency', 'payment_status', 'payment_method',
      'payment_reference', 'subscription_start', 'subscription_end', 'status',
      'notes', 'invoice_url', 'created_at'
    ],
    json: []
  },
  customer_remarks: {
    columns: ['customer_id', 'user_id', 'remark', 'remark_type', 'created_at'],
    json: []
  },
  monthly_targets: {
    columns: [
      'user_id', 'month', 'target_revenue', 'target_leads',
      'target_sales', 'target_calls', 'notes',
      'created_by', 'created_at', 'updated_at'
    ],
    json: []
  }
};

function _schema(table) {
  const s = SCHEMA[table];
  if (!s) throw new Error(`Unknown table: ${table}`);
  return s;
}

// Columns that should never accept '' — silently convert to null.
// Covers integer FKs, timestamps, booleans, numerics across the schema.
const NULLABLE_INTS = new Set([
  'parent_id', 'manager_id', 'team_leader_id',
  'status_id', 'assigned_to', 'created_by', 'user_id', 'lead_id',
  'product_id', 'duplicate_of', 'approved_by',
  'is_active', 'is_read', 'is_done', 'is_final', 'is_required',
  'is_duplicate', 'show_in_list', 'sort_order', 'priority',
  'monthly_salary', 'base', 'allowances', 'deductions', 'net_pay', 'value'
]);
const NULLABLE_TS = new Set([
  'created_at', 'updated_at', 'last_status_change_at', 'next_followup_at',
  'check_in', 'check_out', 'due_at', 'completed_at', 'done_at',
  'received_at', 'joining_date', 'from_date', 'to_date'
]);

function _coerce(k, v) {
  if (v === '' && (NULLABLE_INTS.has(k) || NULLABLE_TS.has(k))) return null;
  return v;
}

function _serialize(table, row) {
  const { columns, json } = _schema(table);
  const out = {};
  for (const k of columns) {
    if (row[k] === undefined) continue;
    let v = _coerce(k, row[k]);
    if (json.includes(k)) {
      if (v === '' || v == null) v = null;
      else if (typeof v !== 'string') v = JSON.stringify(v);
    }
    out[k] = v;
  }
  return out;
}

function _deserialize(table, row) {
  if (!row) return row;
  const { json } = _schema(table);
  for (const k of json) {
    if (row[k] && typeof row[k] === 'string') {
      try { row[k] = JSON.parse(row[k]); } catch (_) {}
    }
  }
  return row;
}

/**
 * Pick the right pg.Pool for this call:
 *   - if we're inside tenantStorage.run({ pool }), use that pool
 *     (i.e. we're handling a /t/<slug>/api request)
 *   - otherwise fall back to the global pool keyed by DATABASE_URL
 *     (control plane scripts, migrations, single-tenant standalone)
 *
 * Returning the right pool here is the single hinge that makes every
 * route file in /routes/* automatically multi-tenant without any
 * per-route refactor.
 */
function _activePool() {
  const store = tenantStorage.getStore();
  if (store && store.pool) return store.pool;
  return pool;
}

async function query(sql, params) {
  const p = _activePool();
  const client = await p.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

async function getAll(table) {
  _schema(table);
  const { rows } = await query(`SELECT * FROM ${table} ORDER BY id ASC`);
  return rows.map(r => _deserialize(table, r));
}

async function findById(table, id) {
  _schema(table);
  const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ? _deserialize(table, rows[0]) : null;
}

async function findOneBy(table, field, value) {
  _schema(table);
  const { rows } = await query(
    `SELECT * FROM ${table} WHERE ${field} = $1 LIMIT 1`,
    [value]
  );
  return rows[0] ? _deserialize(table, rows[0]) : null;
}

async function findBy(table, field, value) {
  _schema(table);
  const { rows } = await query(
    `SELECT * FROM ${table} WHERE ${field} = $1 ORDER BY id ASC`,
    [value]
  );
  return rows.map(r => _deserialize(table, r));
}

async function insert(table, row) {
  const data = _serialize(table, row);
  const keys = Object.keys(data);
  if (keys.length === 0) throw new Error(`insert: no valid columns for ${table}`);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const cols = keys.join(', ');
  const values = keys.map(k => data[k]);
  const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING id`;
  const { rows } = await query(sql, values);
  return rows[0].id;
}

async function update(table, id, patch) {
  const data = _serialize(table, patch);
  const keys = Object.keys(data);
  if (keys.length === 0) return 0;
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map(k => data[k]);
  values.push(id);
  const sql = `UPDATE ${table} SET ${setClause} WHERE id = $${values.length}`;
  const res = await query(sql, values);
  return res.rowCount;
}

async function removeRow(table, id) {
  _schema(table);
  const res = await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return res.rowCount;
}

function nowIso() {
  return new Date().toISOString();
}

// Simple key/value config helpers (replaces GAS Script Properties)
async function getConfig(key, fallback) {
  const r = await findOneBy('config', 'key', key);
  if (r && r.value != null) return r.value;
  return process.env[key] != null ? process.env[key] : fallback;
}
async function setConfig(key, value) {
  const existing = await findOneBy('config', 'key', key);
  if (existing) {
    await update('config', existing.id, { value: String(value), updated_at: nowIso() });
  } else {
    await insert('config', { key, value: String(value), updated_at: nowIso() });
  }
}

module.exports = {
  pool, query,
  getAll, findById, findOneBy, findBy,
  insert, update, removeRow,
  getConfig, setConfig, nowIso,
  SCHEMA,
  // Multi-tenant: server.js wraps each /t/<slug>/api request in
  // tenantStorage.run({ pool }, fn) so _activePool() picks up the
  // tenant-scoped pg.Pool instead of the default DATABASE_URL one.
  tenantStorage
};
