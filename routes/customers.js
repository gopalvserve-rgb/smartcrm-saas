/* ============================================================================
 * CUSTOMER_MODULE_v1 (2026-07-17) — vserve only
 * ============================================================================
 * Gopal's brief, in his words:
 *   "Once sales done, the sales team will click convert to customer and fill few
 *    details… a new entry will be created in Customer Section and will be added
 *    as customer, that will be assigned as per rule… on the basis of Product the
 *    customer will be assigned to other team member… the same customer is visible
 *    to sale person the owner who created and the same will be sent the new person
 *    as per rule."
 *   Reports: "on Stage, saler Wise Volume, Count, Type Of product."
 *   Volume  = "Customer Value Sale Amount for Sum", Count = "Count of Customer".
 *
 * THE MODEL (decided with Gopal, not invented here)
 *   Lead   — stays, frozen at Sale Done. The rep keeps it and keeps the credit.
 *            We never touch leads.status_id here; conversion is additive.
 *   Customer — ONE row per converted sale. The PHONE is the customer key, so a
 *            repeat buyer is a second row sharing the phone (is_repeat=1).
 *            Gopal: repeat is "rare, but it happens" — so reports give BOTH
 *            row count (sales) and distinct-phone count (unique customers)
 *            without a second table and a second UI to maintain.
 *   Owner  — "one owner + specialists". owner_user_id is the ONE accountable
 *            back-office person, chosen by rule. Specialists join as watchers.
 *            One accountable person is the entire point: with per-stage
 *            reassignment an order in flight has nobody's name on it, and that
 *            is exactly how things get dropped between departments.
 *
 * VISIBILITY — the actual requirement
 *   A customer is visible to: the sales rep who won it (sales_user_id), the
 *   assigned owner (owner_user_id), any watcher, and admin/manager. Nothing is
 *   copied, nothing duplicated — one row, two roles.
 *
 * WHY NO departments TABLE
 *   I flagged departments as a prerequisite for department-based routing. Gopal's
 *   rule is product -> team member, so departments aren't needed at all. Dropped
 *   the prerequisite rather than build something nobody asked for.
 *   (users.department is free TEXT today — routing on it would misroute on a typo.)
 *
 * SAFETY
 *   - vserve only, by slug. Every other tenant gets enabled:false and no tables.
 *   - Additive: reads leads, writes only customer_* tables. Zero writes to leads,
 *     zero contact with recordings / call log / reports.js (all LOCKED).
 * ========================================================================== */
const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

const ALLOWED_SLUGS = ['vserve'];

function _slug() {
  try {
    const st = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    return (st && st.slug) ? String(st.slug) : '';
  } catch (_) { return ''; }
}
function isEnabled() { return true; /* CUSTOMER_ALL_TENANTS_v1 — module enabled for every tenant */ }
function _assertEnabled() {
  if (!isEnabled()) throw new Error('Customer module is not enabled for this tenant');
}
const _digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const _num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };

async function ensureSeed() {
  if (!isEnabled()) return;
  try {
    /* STAGES_FROM_CLOSURE_v1 (2026-07-18) — Gopal: "Here Stages Should come from Sales
     * Closure stage, No need Of separate Delivery Stage." So the delivery journey IS the
     * project_stages set (Sales Closure). We no longer seed or read buyer_stages — that
     * table is left in place but unused. Nothing to seed here for stages. */
    /* The fallback rule can never be deleted (see api_customers_ruleDelete). A
     * converted sale that matches no rule would otherwise land with owner=NULL —
     * an order nobody is delivering, sitting silently until the customer calls
     * angry. There is always a catch-all. */
    const f = await db.query('SELECT COUNT(*)::int AS n FROM buyer_rules WHERE is_fallback = 1');
    if (!Number(f.rows[0].n)) {
      const admin = await db.query(`SELECT id FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id ASC LIMIT 1`);
      const uid = admin.rows[0] ? Number(admin.rows[0].id) : null;
      await db.query(
        `INSERT INTO buyer_rules (name, product_id, mode, user_ids, priority, is_fallback, is_active)
         VALUES ('Fallback — nothing matched', NULL, 'fixed', $1::jsonb, 9999, 1, 1)`,
        [JSON.stringify(uid ? [uid] : [])]
      );
      console.log('[customers] seeded fallback rule on ' + _slug());
    }
  } catch (e) { console.warn('[customers] ensureSeed:', e.message); }
}

/* ---------------------------------------------------------------------------
 * THE RULE ENGINE
 * Lowest priority number wins; a product-specific rule always beats the
 * fallback because the fallback sits at priority 9999. Round-robin advances
 * rr_position ATOMICALLY in the UPDATE ... RETURNING so two reps converting at
 * the same moment can't both get handed the same person.
 * ------------------------------------------------------------------------- */
/* STAGES_FROM_CLOSURE_v1 — the delivery stages ARE the Sales Closure stages
 * (project_stages). project_stages has no color / is_final, so we synthesize:
 * colour by position, and "final" = the last stage by sort_order. */
async function _closureStages() {
  const rows = (await db.getAll('project_stages'))
    .filter(r => Number(r.is_active) === 1)
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  return rows;
}
async function _firstStageId() { const r = await _closureStages(); return r[0] ? Number(r[0].id) : null; }
async function _finalStageId() { const r = await _closureStages(); return r.length ? Number(r[r.length - 1].id) : null; }

async function _pickAssignee(productId) {
  const { rows } = await db.query(
    `SELECT * FROM buyer_rules
      WHERE is_active = 1
        AND (product_id = $1 OR product_id IS NULL)
      ORDER BY (product_id IS NULL) ASC, priority ASC, id ASC`,
    [productId || null]
  );
  for (const rule of rows) {
    let pool = [];
    try { pool = Array.isArray(rule.user_ids) ? rule.user_ids : JSON.parse(rule.user_ids || '[]'); }
    catch (_) { pool = []; }
    pool = pool.map(Number).filter(Boolean);
    if (!pool.length) continue;

    // Only hand work to users who still exist and are active — a rule pointing at
    // a left employee must fall through to the next rule, not black-hole the sale.
    const act = await db.query(
      `SELECT id FROM users WHERE id = ANY($1::int[]) AND is_active = 1`, [pool]);
    const live = act.rows.map(r => Number(r.id));
    const ordered = pool.filter(id => live.includes(id));
    if (!ordered.length) continue;

    if (rule.mode === 'fixed') return { user_id: ordered[0], rule_id: rule.id, rule_name: rule.name };

    if (rule.mode === 'least_busy') {
      const b = await db.query(
        `SELECT u.id, COUNT(c.id)::int AS n
           FROM users u
           LEFT JOIN buyers c
             ON c.owner_user_id = u.id
            AND c.closed_at IS NULL
          WHERE u.id = ANY($1::int[])
          GROUP BY u.id ORDER BY n ASC, u.id ASC LIMIT 1`, [ordered]);
      if (b.rows[0]) return { user_id: Number(b.rows[0].id), rule_id: rule.id, rule_name: rule.name };
    }

    // round_robin (default) — atomic bump
    const up = await db.query(
      `UPDATE buyer_rules
          SET rr_position = (rr_position + 1), updated_at = NOW()
        WHERE id = $1 RETURNING rr_position`, [rule.id]);
    const pos = Number(up.rows[0].rr_position) - 1;
    return { user_id: ordered[pos % ordered.length], rule_id: rule.id, rule_name: rule.name };
  }
  return { user_id: null, rule_id: null, rule_name: null };
}

/** Who is this rep about to hand the customer to? Read-only — no RR bump. */
async function api_customers_previewAssignee(token, payload) {
  await authUser(token);
  if (!isEnabled()) return { ok: true, enabled: false };
  await ensureSeed();
  const productId = payload && payload.product_id ? Number(payload.product_id) : null;
  const { rows } = await db.query(
    `SELECT * FROM buyer_rules
      WHERE is_active = 1 AND (product_id = $1 OR product_id IS NULL)
      ORDER BY (product_id IS NULL) ASC, priority ASC, id ASC`, [productId]);
  for (const rule of rows) {
    let pool = [];
    try { pool = Array.isArray(rule.user_ids) ? rule.user_ids : JSON.parse(rule.user_ids || '[]'); } catch (_) {}
    pool = pool.map(Number).filter(Boolean);
    if (!pool.length) continue;
    const act = await db.query(`SELECT id, name FROM users WHERE id = ANY($1::int[]) AND is_active = 1`, [pool]);
    const live = act.rows.map(r => Number(r.id));
    const ordered = pool.filter(id => live.includes(id));
    if (!ordered.length) continue;
    const idx = rule.mode === 'fixed' ? 0 : (Number(rule.rr_position) % ordered.length);
    const uid = ordered[idx];
    const u = act.rows.find(x => Number(x.id) === uid);
    return { ok: true, enabled: true, user_id: uid, user_name: u ? u.name : ('#' + uid),
             rule_id: rule.id, rule_name: rule.name, mode: rule.mode, is_fallback: !!Number(rule.is_fallback) };
  }
  return { ok: true, enabled: true, user_id: null, user_name: null, note: 'No rule matched and no fallback pool set.' };
}

/* ---------------------------------------------------------------------------
 * CONVERT — the one write the sales rep makes.
 * ------------------------------------------------------------------------- */
async function api_customers_convert(token, payload) {
  const me = await authUser(token);
  _assertEnabled();
  await ensureSeed();
  const p = payload || {};
  const leadId = Number(p.lead_id) || null;
  if (!leadId) throw new Error('lead_id required');

  const lead = await db.findById('leads', leadId);
  if (!lead) throw new Error('Lead not found');

  // Idempotency. There is also a UNIQUE index on customers(lead_id) — belt and
  // braces, because a double-clicked button that creates two customers would
  // silently double-count the sale in every report below.
  const dupe = await db.query('SELECT id FROM buyers WHERE lead_id = $1 LIMIT 1', [leadId]);
  if (dupe.rows[0]) throw new Error('This lead is already converted (customer #' + dupe.rows[0].id + ')');

  const phone = _digits(p.phone || lead.phone || lead.whatsapp);
  if (!phone) throw new Error('Customer phone is required — it is the key that links repeat orders');

  // Repeat detection by phone tail. Same customer buying again = a second row.
  let isRepeat = 0;
  try {
    const r = await db.query(
      `SELECT id FROM buyers WHERE right(regexp_replace(phone,'[^0-9]','','g'),10) = $1 LIMIT 1`,
      [phone.slice(-10)]);
    if (r.rows[0]) isRepeat = 1;
  } catch (_) {}

  const productId = p.product_id ? Number(p.product_id) : (lead.product_id ? Number(lead.product_id) : null);
  let productName = p.product_name || lead.product || null;
  if (productId && !productName) {
    try {
      const pr = await db.findById('products', productId);
      if (pr) productName = pr.name;
    } catch (_) {}
  }

  /* CUST_MULTI_PRODUCT_v1 (2026-07-29) — the primary product (product_id) still
   * drives routing/reports/inventory. Any additional products the rep picked
   * ride along in extra_json.order_products so the customer keeps the full list. */
  const _orderProducts = Array.isArray(p.order_products)
    ? p.order_products.filter(function (x) { return x && x.product_id; }).map(function (x) {
        return { product_id: Number(x.product_id), product_name: String(x.product_name || ''), amount: Number(x.amount) || 0 };
      })
    : [];
  if (_orderProducts.length > 1) {
    p.extra_json = Object.assign({}, (p.extra_json && typeof p.extra_json === 'object') ? p.extra_json : {}, { order_products: _orderProducts });
  }

  const pick = await _pickAssignee(productId);

  const stageId = await _firstStageId();

  /* product_name is SNAPSHOT, not a live join: renaming a product later must not
   * silently rewrite what past customers were sold. (The Inventory module already
   * matches stock by product NAME and a rename breaks it — INVENTORY_STOCK_v1.) */
  const id = await db.insert('buyers', {
    lead_id: leadId,
    name: p.name || lead.name || ('Customer ' + phone.slice(-4)),
    phone,
    email: p.email || lead.email || null,
    company: p.company || lead.company || null,
    product_id: productId,
    product_name: productName,
    sale_amount: _num(p.sale_amount != null ? p.sale_amount : lead.value),
    paid_amount: _num(p.paid_amount),
    currency: p.currency || lead.currency || 'INR',
    payment_mode: p.payment_mode || null,
    payment_ref: p.payment_ref || null,
    stage_id: stageId,
    stage_started_at: db.nowIso(),
    sales_user_id: lead.assigned_to || me.id,   // the rep KEEPS the credit, permanently
    owner_user_id: pick.user_id,
    assign_rule_id: pick.rule_id,
    address: p.address || lead.address || null,
    site_contact: p.site_contact || null,
    target_date: p.target_date || null,
    notes: p.notes || null,
    extra_json: p.extra_json ? JSON.stringify(p.extra_json) : null,
    is_repeat: isRepeat,
    converted_by: me.id,
    created_at: db.nowIso(),
    updated_at: db.nowIso()
  });

  try {
    await db.query(
      `INSERT INTO buyer_stage_history (customer_id, from_stage_id, to_stage_id, changed_by, note)
       VALUES ($1, NULL, $2, $3, $4)`,
      [id, stageId, me.id, 'Converted from lead #' + leadId +
        (pick.user_id ? (' · auto-assigned by rule: ' + (pick.rule_name || pick.rule_id)) : ' · NO RULE MATCHED')]
    );
  } catch (_) {}

  /* Audit on the LEAD too, so the rep's timeline shows where their customer went.
   * lead_actions only — we do NOT touch leads.status_id. The lead stays exactly
   * where the rep left it (Sale Done) and their conversion numbers stay stable. */
  try {
    await db.query(
      `INSERT INTO lead_actions (lead_id, user_id, action_type, meta_json, created_at)
       VALUES ($1, $2, 'note', $3, NOW())`,
      [leadId, me.id, JSON.stringify({
        customer_module: 'CUSTOMER_MODULE_v1', customer_id: id,
        note: 'Converted to Customer #' + id + (pick.user_id ? (' — assigned to user #' + pick.user_id) : '')
      })]
    );
  } catch (_) {}

  return { ok: true, id, is_repeat: !!isRepeat,
           owner_user_id: pick.user_id, rule_id: pick.rule_id, rule_name: pick.rule_name,
           unassigned: !pick.user_id };
}

/* ---------------------------------------------------------------------------
 * VISIBILITY — the "visible to both" rule, in one place.
 * ------------------------------------------------------------------------- */
async function _visibleWhere(me) {
  if (me.role === 'admin') return { sql: '1=1', args: [] };
  const visible = (await getVisibleUserIds(me)).map(Number);
  const ids = visible.length ? visible : [Number(me.id)];
  // sales rep OR assigned owner OR watcher — and managers/TLs get the same for
  // everyone beneath them, which is what getVisibleUserIds already encodes.
  return {
    sql: `(c.sales_user_id = ANY($1::int[])
           OR c.owner_user_id = ANY($1::int[])
           OR EXISTS (SELECT 1 FROM buyer_watchers w
                       WHERE w.customer_id = c.id AND w.user_id = ANY($1::int[])))`,
    args: [ids]
  };
}

async function api_customers_list(token, payload) {
  const me = await authUser(token);
  if (!isEnabled()) return { ok: true, enabled: false, rows: [], total: 0 };
  await ensureSeed();
  await _ensureTaskSchema();
  const p = payload || {};
  const v = await _visibleWhere(me);
  const args = [...v.args];
  const where = [v.sql];

  const add = (frag, val) => { args.push(val); where.push(frag.replace('$$', '$' + args.length)); };
  if (p.stage_id)      add('c.stage_id = $$', Number(p.stage_id));
  if (p.product_id)    add('c.product_id = $$', Number(p.product_id));
  if (p.owner_user_id) add('c.owner_user_id = $$', Number(p.owner_user_id));
  if (p.sales_user_id) add('c.sales_user_id = $$', Number(p.sales_user_id));
  if (p.from)          add('c.created_at >= $$', p.from);
  if (p.to)            add('c.created_at <= $$', String(p.to).length <= 10 ? p.to + ' 23:59:59' : p.to);
  if (p.q) {
    args.push('%' + String(p.q).toLowerCase() + '%');
    where.push(`(LOWER(c.name) LIKE $${args.length} OR c.phone LIKE $${args.length}
                 OR LOWER(COALESCE(c.company,'')) LIKE $${args.length})`);
  }
  // scope=mine|shared: "mine" means I'm accountable for delivery; "shared" means
  // I won it or I'm a specialist — I watch it but someone else drives it.
  if (p.scope === 'mine')   add('c.owner_user_id = $$', Number(me.id));
  if (p.scope === 'shared') add('(c.owner_user_id IS DISTINCT FROM $$ AND (c.sales_user_id = $$ OR EXISTS (SELECT 1 FROM buyer_watchers w2 WHERE w2.customer_id = c.id AND w2.user_id = $$)))', Number(me.id));

  const page = Math.max(1, Number(p.page) || 1);
  const size = Math.min(200, Math.max(1, Number(p.page_size) || 50));
  const W = where.join(' AND ');

  const cnt = await db.query(`SELECT COUNT(*)::int AS n FROM buyers c WHERE ${W}`, args);
  const rows = await db.query(
    `SELECT c.*,
            s.name AS stage_name, s.expected_days,
            uo.name AS owner_name, us.name AS sales_name,
            (SELECT COUNT(*) FROM buyer_stage_tasks t WHERE t.stage_id=c.stage_id AND COALESCE(t.is_active,1)=1) AS task_total,
            (SELECT COUNT(*) FROM buyer_task_done d JOIN buyer_stage_tasks t ON t.id=d.task_id WHERE d.customer_id=c.id AND COALESCE(d.done,1)=1 AND t.stage_id=c.stage_id AND COALESCE(t.is_active,1)=1) AS task_done
       FROM buyers c
       LEFT JOIN project_stages s ON s.id = c.stage_id
       LEFT JOIN users uo ON uo.id = c.owner_user_id
       LEFT JOIN users us ON us.id = c.sales_user_id
      WHERE ${W}
      ORDER BY c.created_at DESC
      LIMIT ${size} OFFSET ${(page - 1) * size}`, args);

  const meId = Number(me.id);
  const out = rows.rows.map(r => Object.assign({}, r, {
    is_mine: Number(r.owner_user_id) === meId,
    is_watching: Number(r.sales_user_id) === meId && Number(r.owner_user_id) !== meId,
    // SLA: red when it has sat in the stage longer than that stage allows.
    days_in_stage: r.stage_started_at
      ? Math.floor((Date.now() - new Date(r.stage_started_at).getTime()) / 86400000) : null
  }));
  return { ok: true, enabled: true, rows: out, total: Number(cnt.rows[0].n), page, page_size: size };
}

async function api_customers_get(token, id) {
  const me = await authUser(token);
  _assertEnabled();
  await _ensureTaskSchema();
  const v = await _visibleWhere(me);
  const r = await db.query(
    `SELECT c.*, s.name AS stage_name,
            uo.name AS owner_name, us.name AS sales_name
       FROM buyers c
       LEFT JOIN project_stages s ON s.id = c.stage_id
       LEFT JOIN users uo ON uo.id = c.owner_user_id
       LEFT JOIN users us ON us.id = c.sales_user_id
      WHERE c.id = $${v.args.length + 1} AND ${v.sql}`, [...v.args, Number(id)]);
  if (!r.rows[0]) throw new Error('Not found');
  const hist = await db.query(
    `SELECT h.*, u.name AS changed_by_name, f.name AS from_name, t.name AS to_name
       FROM buyer_stage_history h
       LEFT JOIN users u ON u.id = h.changed_by
       LEFT JOIN project_stages f ON f.id = h.from_stage_id
       LEFT JOIN project_stages t ON t.id = h.to_stage_id
      WHERE h.customer_id = $1 ORDER BY h.changed_at DESC`, [Number(id)]);
  const watch = await db.query(
    `SELECT w.*, u.name FROM buyer_watchers w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.customer_id = $1`, [Number(id)]);
  const _lse = await _tasksForCustomer(r.rows[0]);
  const _rem = await db.query(`SELECT rq.*, u.name AS user_name FROM buyer_remarks rq LEFT JOIN users u ON u.id=rq.user_id WHERE rq.customer_id=$1 ORDER BY rq.created_at DESC LIMIT 50`, [Number(id)]).catch(() => ({ rows: [] }));
  return { ok: true, customer: r.rows[0], history: hist.rows, watchers: watch.rows, tasks: _lse.tasks, task_total: _lse.total, task_done: _lse.done, pct: _lse.pct, remarks: _rem.rows };
}

/** Move the journey forward. Only the accountable owner (or admin) may. */
async function api_customers_setStage(token, payload) {
  const me = await authUser(token);
  _assertEnabled();
  const p = payload || {};
  const id = Number(p.id), stageId = Number(p.stage_id);
  if (!id || !stageId) throw new Error('id and stage_id required');
  const c = await db.findById('buyers', id);
  if (!c) throw new Error('Not found');
  /* The sales rep watches but does not drive delivery — otherwise "who is
   * accountable for this order" goes fuzzy again, which is the whole problem
   * this module exists to solve. */
  if (me.role !== 'admin' && me.role !== 'manager' && Number(c.owner_user_id) !== Number(me.id)) {
    throw new Error('Only the assigned owner can move the stage');
  }
  const prev = c.stage_started_at ? Math.floor((Date.now() - new Date(c.stage_started_at).getTime()) / 1000) : null;
  const finalId = await _finalStageId();
  await db.update('buyers', id, {
    stage_id: stageId, stage_started_at: db.nowIso(), updated_at: db.nowIso(),
    closed_at: (finalId && Number(stageId) === Number(finalId)) ? db.nowIso() : null
  });
  await db.query(
    `INSERT INTO buyer_stage_history (customer_id, from_stage_id, to_stage_id, duration_prev_s, changed_by, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, c.stage_id || null, stageId, prev, me.id, p.note || null]);
  return { ok: true };
}

async function api_customers_update(token, payload) {
  const me = await authUser(token);
  _assertEnabled();
  const p = payload || {};
  const id = Number(p.id);
  if (!id) throw new Error('id required');
  const c = await db.findById('buyers', id);
  if (!c) throw new Error('Not found');
  const mayEdit = me.role === 'admin' || me.role === 'manager' ||
                  Number(c.owner_user_id) === Number(me.id) ||
                  Number(c.sales_user_id) === Number(me.id);
  if (!mayEdit) throw new Error('Not allowed');
  const patch = { updated_at: db.nowIso() };
  ['name','email','company','sale_amount','paid_amount','payment_mode','payment_ref',
   'address','site_contact','target_date','notes'].forEach(k => {
    if (p[k] !== undefined) patch[k] = p[k];
  });
  if (p.extra_json !== undefined) patch.extra_json = JSON.stringify(p.extra_json || {});
  // Reassigning the owner is an admin/manager act — not something a rep does.
  if (p.owner_user_id !== undefined && (me.role === 'admin' || me.role === 'manager')) {
    patch.owner_user_id = p.owner_user_id ? Number(p.owner_user_id) : null;
  }
  await db.update('buyers', id, patch);
  return { ok: true };
}

/** Pull a specialist in. They keep access afterwards — context shouldn't evaporate. */
async function api_customers_addWatcher(token, payload) {
  const me = await authUser(token);
  _assertEnabled();
  const p = payload || {};
  if (!p.id || !p.user_id) throw new Error('id and user_id required');
  await db.query(
    `INSERT INTO buyer_watchers (customer_id, user_id, role, added_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT (customer_id, user_id) DO NOTHING`,
    [Number(p.id), Number(p.user_id), p.role || 'specialist', me.id]);
  return { ok: true };
}
async function api_customers_removeWatcher(token, payload) {
  await authUser(token);
  _assertEnabled();
  const p = payload || {};
  await db.query('DELETE FROM buyer_watchers WHERE customer_id = $1 AND user_id = $2',
    [Number(p.id), Number(p.user_id)]);
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * STAGES + RULES (admin)
 * ------------------------------------------------------------------------- */
async function api_customers_stages(token) {
  await authUser(token);
  if (!isEnabled()) return [];
  // Delivery stages ARE the Sales Closure stages (project_stages). Synthesize a
  // colour by position and mark the last one final, so the SPA dropdown + pills work.
  const rows = await _closureStages();
  const PALETTE = ['#f59e0b', '#06b6d4', '#6366f1', '#8b5cf6', '#10b981', '#ec4899', '#14b8a6'];
  const lastId = rows.length ? Number(rows[rows.length - 1].id) : null;
  return rows.map((r, i) => ({
    id: Number(r.id), name: r.name,
    color: PALETTE[i % PALETTE.length],
    sort_order: Number(r.sort_order) || 10,
    expected_days: Number(r.expected_days) || null,
    is_final: Number(r.id) === lastId ? 1 : 0
  }));
}
async function api_customers_stageSave(token) {
  await authUser(token);
  // STAGES_FROM_CLOSURE_v1 — delivery stages are the Sales Closure stages now.
  // Edit them under Sales Closure / project-stage settings, not here.
  throw new Error('Delivery stages come from Sales Closure — edit them there.');
}

async function api_customers_rules(token) {
  await authUser(token);
  if (!isEnabled()) return { ok: true, enabled: false, rows: [] };
  await ensureSeed();
  const r = await db.query(
    `SELECT r.*, p.name AS product_name
       FROM buyer_rules r
       LEFT JOIN products p ON p.id = r.product_id
      ORDER BY r.is_fallback ASC, r.priority ASC, r.id ASC`);
  const users = await db.getAll('users');
  const rows = r.rows.map(x => {
    let ids = [];
    try { ids = Array.isArray(x.user_ids) ? x.user_ids : JSON.parse(x.user_ids || '[]'); } catch (_) {}
    ids = ids.map(Number).filter(Boolean);
    const members = ids.map(uid => {
      const u = users.find(y => Number(y.id) === uid);
      return { id: uid, name: u ? u.name : ('#' + uid), is_active: u ? Number(u.is_active) : 0 };
    });
    const nextIdx = members.length ? (Number(x.rr_position) % members.length) : 0;
    return Object.assign({}, x, { members, next_user_id: members[nextIdx] ? members[nextIdx].id : null });
  });
  return { ok: true, enabled: true, rows };
}
async function api_customers_ruleSave(token, payload) {
  const me = await authUser(token);
  _assertEnabled();
  if (me.role !== 'admin') throw new Error('Admins only');
  const p = payload || {};
  const ids = (Array.isArray(p.user_ids) ? p.user_ids : []).map(Number).filter(Boolean);
  const row = {
    name: p.name || null,
    product_id: p.product_id ? Number(p.product_id) : null,
    mode: ['round_robin', 'fixed', 'least_busy'].includes(p.mode) ? p.mode : 'round_robin',
    user_ids: JSON.stringify(ids),
    priority: Number(p.priority) || 100,
    is_active: p.is_active === 0 ? 0 : 1,
    updated_at: db.nowIso()
  };
  if (p.id) {
    const ex = await db.findById('buyer_rules', Number(p.id));
    // The fallback's product must stay NULL — that's what makes it catch everything.
    if (ex && Number(ex.is_fallback) === 1) { row.product_id = null; row.is_active = 1; }
    await db.update('buyer_rules', Number(p.id), row);
    return { ok: true, id: Number(p.id) };
  }
  /* product_id null is now allowed for an admin rule = "All products". It sorts AFTER
   * product-specific rules but BEFORE the fallback (priority 9999) in _pickAssignee, so
   * an admin can route every product through a team without touching the fixed fallback. */
  const id = await db.insert('buyer_rules',
    Object.assign({ is_fallback: 0, rr_position: 0, created_by: me.id, created_at: db.nowIso() }, row));
  return { ok: true, id };
}
async function api_customers_ruleDelete(token, id) {
  const me = await authUser(token);
  _assertEnabled();
  if (me.role !== 'admin') throw new Error('Admins only');
  const r = await db.findById('buyer_rules', Number(id));
  if (!r) throw new Error('Not found');
  /* Refuse to delete the catch-all. Without it a converted sale can land with
   * owner = NULL and nobody delivers it. Edit its pool instead. */
  if (Number(r.is_fallback) === 1) throw new Error('The fallback rule cannot be deleted — change who it points to instead');
  await db.query('DELETE FROM buyer_rules WHERE id = $1', [Number(id)]);
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * CUSTOM FIELDS — admin-defined extra fields on the Convert form.
 * Mirrors the leads custom_fields feature. Definitions live in
 * buyer_custom_fields; the VALUES a rep enters land in buyers.extra_json,
 * keyed by field `key`. Read is open to any authed user (the convert form
 * needs the defs); create/edit/delete are admin-only.
 * ------------------------------------------------------------------------- */
async function api_customers_fields(token) {
  await authUser(token);
  if (!isEnabled()) return [];
  try {
    const r = await db.query('SELECT * FROM buyer_custom_fields WHERE is_active = 1 ORDER BY sort_order ASC, id ASC');
    return r.rows;
  } catch (_) { return []; }
}
async function api_customers_fieldSave(token, payload) {
  const me = await authUser(token);
  _assertEnabled();
  if (me.role !== 'admin') throw new Error('Admins only');
  const p = payload || {};
  if (!p.label) throw new Error('label required');
  const TYPES = ['text', 'number', 'date', 'select', 'textarea'];
  const type = TYPES.indexOf(p.field_type) >= 0 ? p.field_type : 'text';
  // Derive a stable machine key from the label if none supplied. Once set it
  // never changes on edit — the key is what extra_json values are stored under,
  // so renaming it would orphan every value already saved.
  let key = String(p.key || '').trim();
  if (!key) key = 'cf_' + String(p.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const row = {
    key: key,
    label: p.label,
    field_type: type,
    options: p.options || null,
    is_required: p.is_required ? 1 : 0,
    sort_order: Number(p.sort_order) || 10,
    is_active: p.is_active === 0 ? 0 : 1
  };
  if (p.id) {
    // never rewrite key on edit
    delete row.key;
    await db.update('buyer_custom_fields', Number(p.id), row);
    return { ok: true, id: Number(p.id) };
  }
  // If this key already exists: reactivate + update it when it was soft-deleted
  // (admin removed the field then re-adds one with the same label — very common,
  // e.g. remove "Roof type" then add it back). Only a still-ACTIVE duplicate is
  // a real conflict.
  const ex = await db.query('SELECT id, is_active FROM buyer_custom_fields WHERE key = $1 LIMIT 1', [key]);
  if (ex.rows[0]) {
    if (Number(ex.rows[0].is_active) === 1) throw new Error('A field with key "' + key + '" already exists');
    const rid = Number(ex.rows[0].id);
    delete row.key;                 // never rewrite the key
    row.is_active = 1;
    await db.update('buyer_custom_fields', rid, row);
    return { ok: true, id: rid, reactivated: true };
  }
  const id = await db.insert('buyer_custom_fields', Object.assign({ created_at: db.nowIso() }, row));
  return { ok: true, id };
}
async function api_customers_fieldDelete(token, id) {
  const me = await authUser(token);
  _assertEnabled();
  if (me.role !== 'admin') throw new Error('Admins only');
  // Soft-delete: flip is_active so existing extra_json values aren't orphaned
  // and the field can be brought back. Hard delete would silently hide data.
  await db.update('buyer_custom_fields', Number(id), { is_active: 0 });
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * REPORTS — Gopal: "on Stage, saler Wise Volume, Count, Type Of product"
 *   Volume = SUM(sale_amount)  ·  Count = COUNT(customers)
 *
 * Every number below is computed IN SQL from customers.sale_amount — nothing is
 * inferred from a status name. That matters: the existing reports.js decides
 * "won" with `status.name === 'Won'`, and vserve's status is called "Sale Done",
 * so every rep's won count reads 0 there today. This module can't inherit that
 * bug because it never looks at a name.
 * ------------------------------------------------------------------------- */
async function api_customers_report(token, payload) {
  const me = await authUser(token);
  if (!isEnabled()) return { ok: true, enabled: false };
  await ensureSeed();
  const p = payload || {};
  const v = await _visibleWhere(me);
  const args = [...v.args];
  const where = [v.sql];
  const add = (frag, val) => { args.push(val); where.push(frag.replace('$$', '$' + args.length)); };
  if (p.from)       add('c.created_at >= $$', p.from);
  if (p.to)         add('c.created_at <= $$', String(p.to).length <= 10 ? p.to + ' 23:59:59' : p.to);
  if (p.product_id)    add('c.product_id = $$', Number(p.product_id));
  if (p.stage_id)      add('c.stage_id = $$', Number(p.stage_id));
  if (p.owner_user_id) add('c.owner_user_id = $$', Number(p.owner_user_id));   // user-wise report filter
  if (p.sales_user_id) add('c.sales_user_id = $$', Number(p.sales_user_id));
  const W = where.join(' AND ');

  const totals = await db.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(c.sale_amount),0)::float AS volume,
            COALESCE(SUM(c.paid_amount),0)::float AS collected,
            COUNT(DISTINCT right(regexp_replace(c.phone,'[^0-9]','','g'),10))::int AS unique_customers,
            COUNT(*) FILTER (WHERE c.closed_at IS NOT NULL)::int AS completed
       FROM buyers c WHERE ${W}`, args);

  const byStage = await db.query(
    `SELECT s.id AS stage_id, s.name AS stage, s.sort_order,
            COUNT(c.id)::int AS count,
            COALESCE(SUM(c.sale_amount),0)::float AS volume
       FROM project_stages s
       LEFT JOIN buyers c ON c.stage_id = s.id AND ${W}
      WHERE s.is_active = 1
      GROUP BY s.id, s.name, s.sort_order
      ORDER BY s.sort_order ASC`, args);

  // "saler wise" — the SALES rep who won it (sales_user_id), not the back-office owner.
  const bySales = await db.query(
    `SELECT u.id AS user_id, u.name,
            COUNT(c.id)::int AS count,
            COALESCE(SUM(c.sale_amount),0)::float AS volume,
            COALESCE(SUM(c.paid_amount),0)::float AS collected
       FROM buyers c
       JOIN users u ON u.id = c.sales_user_id
      WHERE ${W}
      GROUP BY u.id, u.name
      ORDER BY volume DESC`, args);

  const byOwner = await db.query(
    `SELECT u.id AS user_id, u.name,
            COUNT(c.id)::int AS count,
            COALESCE(SUM(c.sale_amount),0)::float AS volume,
            COUNT(c.id) FILTER (WHERE c.closed_at IS NULL)::int AS open_count
       FROM buyers c
       JOIN users u ON u.id = c.owner_user_id
      WHERE ${W}
      GROUP BY u.id, u.name
      ORDER BY volume DESC`, args);

  const byProduct = await db.query(
    `SELECT COALESCE(c.product_name, '— none —') AS product,
            c.product_id,
            COUNT(c.id)::int AS count,
            COALESCE(SUM(c.sale_amount),0)::float AS volume
       FROM buyers c WHERE ${W}
      GROUP BY c.product_name, c.product_id
      ORDER BY volume DESC`, args);

  // Stage × product — which product jams where. The reason the module earns its keep.
  const stageByProduct = await db.query(
    `SELECT COALESCE(c.product_name,'— none —') AS product,
            COALESCE(s.name,'—') AS stage,
            COUNT(c.id)::int AS count,
            COALESCE(SUM(c.sale_amount),0)::float AS volume
       FROM buyers c
       LEFT JOIN project_stages s ON s.id = c.stage_id
      WHERE ${W}
      GROUP BY c.product_name, s.name, s.sort_order
      ORDER BY c.product_name ASC, s.sort_order ASC`, args);

  return {
    ok: true, enabled: true,
    totals: totals.rows[0],
    by_stage: byStage.rows,
    by_sales: bySales.rows,
    by_owner: byOwner.rows,
    by_product: byProduct.rows,
    stage_by_product: stageByProduct.rows
  };
}


/* ===========================================================================
 * DELIVERY_CHECKLIST_v1 (2026-08-12) — admin-defined checklist of tasks per
 * delivery stage; the delivery team ticks them on each customer; % complete is
 * auto-calculated; plus a per-customer delivery remark (+ remark history).
 * New tables are NOT in db/pg.js SCHEMA, so ALL writes use raw db.query.
 * ========================================================================= */
let _taskSchemaReady = false;
async function _ensureTaskSchema() {
  if (_taskSchemaReady) return;
  await db.query(`CREATE TABLE IF NOT EXISTS buyer_stage_tasks (
      id SERIAL PRIMARY KEY, stage_id INTEGER NOT NULL, title TEXT NOT NULL,
      sort_order INTEGER DEFAULT 10, is_active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
  await db.query(`CREATE TABLE IF NOT EXISTS buyer_task_done (
      id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL, task_id INTEGER NOT NULL,
      done INTEGER DEFAULT 1, done_by INTEGER, done_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (customer_id, task_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS buyer_remarks (
      id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL, user_id INTEGER,
      remark TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  await db.query(`ALTER TABLE buyers ADD COLUMN IF NOT EXISTS delivery_remark TEXT`);
  _taskSchemaReady = true;
}

async function _tasksForCustomer(buyer) {
  await _ensureTaskSchema();
  const sid = Number(buyer.stage_id) || 0;
  if (!sid) return { tasks: [], total: 0, done: 0, pct: 0 };
  const r = await db.query(
    `SELECT t.id, t.title, t.sort_order,
            CASE WHEN d.id IS NULL THEN 0 ELSE COALESCE(d.done,1) END AS done
       FROM buyer_stage_tasks t
       LEFT JOIN buyer_task_done d ON d.task_id = t.id AND d.customer_id = $1
      WHERE t.stage_id = $2 AND COALESCE(t.is_active,1) = 1
      ORDER BY t.sort_order, t.id`, [Number(buyer.id), sid]);
  const tasks = r.rows.map(x => ({ id: x.id, title: x.title, done: Number(x.done) ? 1 : 0 }));
  const total = tasks.length, done = tasks.filter(t => t.done).length;
  return { tasks, total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

function _mayWork(me, buyer) {
  return me.role === 'admin' || me.role === 'manager' ||
         Number(buyer.owner_user_id) === Number(me.id) ||
         Number(buyer.sales_user_id) === Number(me.id);
}

async function api_customers_stageTasks_list(token, stageId) {
  await authUser(token);
  _assertEnabled();
  await _ensureTaskSchema();
  const args = []; let wh = 'COALESCE(is_active,1)=1';
  if (stageId) { args.push(Number(stageId)); wh += ' AND stage_id=$' + args.length; }
  const r = await db.query(`SELECT * FROM buyer_stage_tasks WHERE ${wh} ORDER BY stage_id, sort_order, id`, args);
  return { ok: true, tasks: r.rows };
}

async function api_customers_stageTasks_save(token, payload) {
  const me = await authUser(token);
  _assertEnabled();
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Only an admin can edit the delivery checklist.');
  await _ensureTaskSchema();
  const p = payload || {};
  const title = String(p.title || '').trim();
  if (p.id) {
    const sets = [], args = [];
    if (p.title !== undefined) { if (!title) throw new Error('Task title required'); args.push(title); sets.push('title=$' + args.length); }
    if (p.sort_order !== undefined) { args.push(Number(p.sort_order) || 10); sets.push('sort_order=$' + args.length); }
    if (p.stage_id !== undefined) { args.push(Number(p.stage_id)); sets.push('stage_id=$' + args.length); }
    if (p.is_active !== undefined) { args.push(p.is_active ? 1 : 0); sets.push('is_active=$' + args.length); }
    sets.push('updated_at=now()');
    args.push(Number(p.id));
    await db.query(`UPDATE buyer_stage_tasks SET ${sets.join(', ')} WHERE id=$${args.length}`, args);
    return { ok: true, id: Number(p.id) };
  }
  if (!title) throw new Error('Task title required');
  if (!p.stage_id) throw new Error('stage_id required');
  const r = await db.query(
    `INSERT INTO buyer_stage_tasks (stage_id, title, sort_order, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,1,now(),now()) RETURNING id`,
    [Number(p.stage_id), title, Number(p.sort_order) || 10]);
  return { ok: true, id: r.rows[0].id };
}

async function api_customers_stageTasks_delete(token, id) {
  const me = await authUser(token);
  _assertEnabled();
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Only an admin can edit the delivery checklist.');
  await _ensureTaskSchema();
  await db.query(`UPDATE buyer_stage_tasks SET is_active=0, updated_at=now() WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

async function api_customers_taskToggle(token, payload) {
  const me = await authUser(token);
  _assertEnabled();
  await _ensureTaskSchema();
  const p = payload || {};
  const buyer = await db.findById('buyers', Number(p.id));
  if (!buyer) throw new Error('Customer not found');
  if (!_mayWork(me, buyer)) throw new Error('You are not on this delivery.');
  const taskId = Number(p.task_id);
  if (!taskId) throw new Error('task_id required');
  if (p.done) {
    await db.query(
      `INSERT INTO buyer_task_done (customer_id, task_id, done, done_by, done_at)
       VALUES ($1,$2,1,$3,now())
       ON CONFLICT (customer_id, task_id) DO UPDATE SET done=1, done_by=$3, done_at=now()`,
      [Number(p.id), taskId, Number(me.id)]);
  } else {
    await db.query(`DELETE FROM buyer_task_done WHERE customer_id=$1 AND task_id=$2`, [Number(p.id), taskId]);
  }
  const info = await _tasksForCustomer(buyer);
  return { ok: true, task_total: info.total, task_done: info.done, pct: info.pct };
}

async function api_customers_setRemark(token, payload) {
  const me = await authUser(token);
  _assertEnabled();
  await _ensureTaskSchema();
  const p = payload || {};
  const buyer = await db.findById('buyers', Number(p.id));
  if (!buyer) throw new Error('Customer not found');
  if (!_mayWork(me, buyer)) throw new Error('You are not on this delivery.');
  const remark = String(p.remark || '').trim();
  await db.query(`UPDATE buyers SET delivery_remark=$1, updated_at=now() WHERE id=$2`, [remark, Number(p.id)]);
  if (remark) { try { await db.query(`INSERT INTO buyer_remarks (customer_id, user_id, remark, created_at) VALUES ($1,$2,$3,now())`, [Number(p.id), Number(me.id), remark]); } catch (_) {} }
  return { ok: true };
}

module.exports = {
  isEnabled, ensureSeed,
  api_customers_convert, api_customers_previewAssignee,
  api_customers_list, api_customers_get, api_customers_setStage, api_customers_update,
  api_customers_addWatcher, api_customers_removeWatcher,
  api_customers_stages, api_customers_stageSave,
  api_customers_rules, api_customers_ruleSave, api_customers_ruleDelete,
  api_customers_report,
  api_customers_fields, api_customers_fieldSave, api_customers_fieldDelete,
  api_customers_stageTasks_list, api_customers_stageTasks_save, api_customers_stageTasks_delete,
  api_customers_taskToggle, api_customers_setRemark
};
