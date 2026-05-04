/**
 * Customers — post-sale lifecycle layer for Stockbox.
 *
 * A customer is created when a lead is converted (typically on Won), and
 * lives independently from there. They can:
 *   - buy multiple products over time (customer_sales)
 *   - renew subscriptions (each renewal is a new sale row)
 *   - upgrade / cross-sell
 *   - lapse / churn — without changing the original lead's funnel state
 *
 * Customer aggregates (lifetime_value, total_purchases, last_purchase_at,
 * next_renewal_at) are recomputed from customer_sales after every write
 * so list views stay fast.
 */
const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

// ---------- helpers ----------------------------------------------------

async function _userMap() {
  const users = await db.getAll('users');
  return Object.fromEntries(users.map(u => [Number(u.id), u]));
}

function _hydrate(c, usersById) {
  return Object.assign({}, c, {
    assigned_name: usersById[Number(c.assigned_to)]?.name || ''
  });
}

async function _isVisible(me, visible, customer) {
  if (me.role === 'admin') return true;
  if (!customer.assigned_to) return false;
  return visible.includes(Number(customer.assigned_to));
}

/**
 * Recompute and persist the rolled-up fields on the customer row from
 * its sales history. Called after every sale write.
 */
async function _refreshAggregates(customerId) {
  const sales = (await db.getAll('customer_sales'))
    .filter(s => Number(s.customer_id) === Number(customerId));
  const lifetime = sales
    .filter(s => s.payment_status !== 'refunded')
    .reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const total = sales.length;
  const lastPurchase = sales
    .map(s => s.sold_at)
    .filter(Boolean)
    .sort((a, b) => String(b).localeCompare(String(a)))[0] || null;
  const futureRenewals = sales
    .filter(s => s.status === 'active' && s.subscription_end)
    .map(s => s.subscription_end)
    .sort((a, b) => String(a).localeCompare(String(b)));
  const nextRenewal = futureRenewals[0] || null;
  await db.update('customers', customerId, {
    lifetime_value: lifetime,
    total_purchases: total,
    last_purchase_at: lastPurchase,
    next_renewal_at: nextRenewal,
    updated_at: db.nowIso()
  });
}

// ---------- list / get -------------------------------------------------

async function api_customers_list(token, filters) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const usersById = await _userMap();
  let rows = (await db.getAll('customers'))
    .filter(c => _isVisibleSync(me, visible, c));
  const f = filters || {};
  if (f.status)       rows = rows.filter(c => c.status === f.status);
  if (f.assigned_to)  rows = rows.filter(c => Number(c.assigned_to) === Number(f.assigned_to));
  if (f.risk_profile) rows = rows.filter(c => c.risk_profile === f.risk_profile);
  if (f.q) {
    const q = String(f.q).toLowerCase();
    rows = rows.filter(c =>
      String(c.name || '').toLowerCase().includes(q) ||
      String(c.phone || '').toLowerCase().includes(q) ||
      String(c.email || '').toLowerCase().includes(q) ||
      String(c.pan || '').toLowerCase().includes(q)
    );
  }
  // "Renewal due" filter: subscription expires within N days
  if (f.renewal_in_days) {
    const cutoff = new Date(Date.now() + Number(f.renewal_in_days) * 86400000).toISOString();
    rows = rows.filter(c => c.next_renewal_at && String(c.next_renewal_at) <= cutoff);
  }
  rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return rows.map(c => _hydrate(c, usersById));
}

function _isVisibleSync(me, visible, customer) {
  if (me.role === 'admin') return true;
  if (!customer.assigned_to) return false;
  return visible.includes(Number(customer.assigned_to));
}

async function api_customers_get(token, id) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const customer = await db.findById('customers', id);
  if (!customer) throw new Error('Customer not found');
  if (!_isVisibleSync(me, visible, customer)) throw new Error('Forbidden');

  const usersById = await _userMap();
  const products = await db.getAll('products');
  const productById = Object.fromEntries(products.map(p => [Number(p.id), p]));

  const sales = (await db.getAll('customer_sales'))
    .filter(s => Number(s.customer_id) === Number(id))
    .sort((a, b) => String(b.sold_at).localeCompare(String(a.sold_at)))
    .map(s => Object.assign({}, s, {
      sold_by_name: usersById[Number(s.sold_by)]?.name || '',
      product_name: s.product_name || productById[Number(s.product_id)]?.name || ''
    }));

  const remarks = (await db.getAll('customer_remarks'))
    .filter(r => Number(r.customer_id) === Number(id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(r => Object.assign({}, r, { user_name: usersById[Number(r.user_id)]?.name || 'System' }));

  return {
    customer: _hydrate(customer, usersById),
    sales,
    remarks
  };
}

// ---------- create / update / delete ----------------------------------

async function api_customers_create(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.name) throw new Error('Name required');
  if (!p.phone && !p.email) throw new Error('Phone or email required');
  const id = await db.insert('customers', {
    from_lead_id:  p.from_lead_id || null,
    name:          String(p.name).trim(),
    phone:         (p.phone || '').replace(/\s+/g, ''),
    alt_phone:     p.alt_phone || '',
    whatsapp:      p.whatsapp || p.phone || '',
    email:         (p.email || '').trim(),
    pan:           (p.pan || '').toUpperCase().trim(),
    date_of_birth: p.date_of_birth || null,
    gender:        p.gender || '',
    occupation:    p.occupation || '',
    income_range:  p.income_range || '',
    risk_profile:  p.risk_profile || '',
    address:       p.address || '',
    city:          p.city || '',
    state:         p.state || '',
    pincode:       p.pincode || '',
    country:       p.country || 'India',
    company:       p.company || '',
    customer_since: p.customer_since || db.nowIso().slice(0, 10),
    status:        p.status || 'active',
    tags:          p.tags || '',
    notes:         p.notes || '',
    assigned_to:   p.assigned_to || me.id,
    extra_json:    p.extra ? JSON.stringify(p.extra) : '',
    created_by:    me.id,
    created_at:    db.nowIso(),
    updated_at:    db.nowIso()
  });
  return { ok: true, id };
}

/**
 * Convert a Won lead into a customer. Carries over contact + attribution
 * data, links back via from_lead_id, and (optionally) creates the first
 * customer_sales row from the lead's value/product so the sale is on
 * record from minute zero.
 */
async function api_customers_convertFromLead(token, leadId, salePayload) {
  const me = await authUser(token);
  const lead = await db.findById('leads', leadId);
  if (!lead) throw new Error('Lead not found');

  const existing = (await db.getAll('customers'))
    .find(c => Number(c.from_lead_id) === Number(leadId));
  if (existing) {
    return { ok: true, id: existing.id, already_existed: true };
  }

  const customerId = await db.insert('customers', {
    from_lead_id:   lead.id,
    name:           lead.name || '',
    phone:          lead.phone || '',
    alt_phone:      lead.alt_phone || '',
    whatsapp:       lead.whatsapp || lead.phone || '',
    email:          lead.email || '',
    address:        lead.address || '',
    city:           lead.city || '',
    state:          lead.state || '',
    pincode:        lead.pincode || '',
    country:        lead.country || 'India',
    company:        lead.company || '',
    tags:           lead.tags || '',
    notes:          lead.notes || '',
    assigned_to:    lead.assigned_to || me.id,
    customer_since: db.nowIso().slice(0, 10),
    status:         'active',
    created_by:     me.id,
    created_at:     db.nowIso(),
    updated_at:     db.nowIso()
  });

  // Auto-record the closing sale, defaulting to the lead's value/product.
  // Caller can pass an explicit salePayload to override (e.g. choosing a
  // different sale_type or amount).
  if (salePayload !== false) {
    const sp = salePayload || {};
    await api_customers_addSale(token, customerId, {
      product_id:      sp.product_id || lead.product_id || null,
      product_name:    sp.product_name || '',
      sale_type:       sp.sale_type || 'new',
      amount:          sp.amount != null ? sp.amount : (lead.value || 0),
      currency:        sp.currency || lead.currency || 'INR',
      payment_status:  sp.payment_status || 'paid',
      payment_method:  sp.payment_method || '',
      payment_reference: sp.payment_reference || '',
      subscription_start: sp.subscription_start || db.nowIso().slice(0, 10),
      subscription_end:   sp.subscription_end || null,
      notes:           sp.notes || 'Converted from lead #' + leadId
    });
  }

  return { ok: true, id: customerId, already_existed: false };
}

async function api_customers_update(token, id, patch) {
  const me = await authUser(token);
  const cust = await db.findById('customers', id);
  if (!cust) throw new Error('Customer not found');

  // Only writable fields — protects aggregates and FKs from API callers.
  const ALLOWED = new Set([
    'name', 'phone', 'alt_phone', 'whatsapp', 'email', 'pan',
    'date_of_birth', 'gender', 'occupation', 'income_range', 'risk_profile',
    'address', 'city', 'state', 'pincode', 'country', 'company',
    'status', 'tags', 'notes', 'assigned_to', 'customer_since'
  ]);
  const allowed = {};
  for (const k of Object.keys(patch || {})) {
    if (ALLOWED.has(k)) allowed[k] = patch[k];
  }
  allowed.updated_at = db.nowIso();
  await db.update('customers', id, allowed);
  return { ok: true };
}

async function api_customers_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Only admins can delete customers');
  // Hard delete cascades sales + remarks via FK.
  await db.query('DELETE FROM customers WHERE id = $1', [Number(id)]);
  return { ok: true };
}

// ---------- sales ------------------------------------------------------

async function api_customers_addSale(token, customerId, payload) {
  const me = await authUser(token);
  const cust = await db.findById('customers', customerId);
  if (!cust) throw new Error('Customer not found');
  const p = payload || {};
  if (!p.amount && p.amount !== 0) throw new Error('Sale amount required');

  const products = await db.getAll('products');
  const productName = p.product_name
    || (p.product_id ? (products.find(x => Number(x.id) === Number(p.product_id))?.name || '') : '');

  const id = await db.insert('customer_sales', {
    customer_id:        Number(customerId),
    product_id:         p.product_id || null,
    product_name:       productName,
    sale_type:          p.sale_type || 'new',
    sold_at:            p.sold_at || db.nowIso(),
    sold_by:            p.sold_by || me.id,
    amount:             Number(p.amount) || 0,
    currency:           p.currency || 'INR',
    payment_status:     p.payment_status || 'paid',
    payment_method:     p.payment_method || '',
    payment_reference:  p.payment_reference || '',
    subscription_start: p.subscription_start || null,
    subscription_end:   p.subscription_end || null,
    status:             p.status || 'active',
    notes:              p.notes || '',
    invoice_url:        p.invoice_url || '',
    created_at:         db.nowIso()
  });
  await _refreshAggregates(customerId);
  return { ok: true, id };
}

async function api_customers_updateSale(token, saleId, patch) {
  const me = await authUser(token);
  const sale = await db.findById('customer_sales', saleId);
  if (!sale) throw new Error('Sale not found');
  const ALLOWED = new Set([
    'product_id', 'product_name', 'sale_type', 'sold_at', 'sold_by',
    'amount', 'currency', 'payment_status', 'payment_method',
    'payment_reference', 'subscription_start', 'subscription_end',
    'status', 'notes', 'invoice_url'
  ]);
  const allowed = {};
  for (const k of Object.keys(patch || {})) {
    if (ALLOWED.has(k)) allowed[k] = patch[k];
  }
  await db.update('customer_sales', saleId, allowed);
  await _refreshAggregates(sale.customer_id);
  return { ok: true };
}

async function api_customers_deleteSale(token, saleId) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or manager only');
  const sale = await db.findById('customer_sales', saleId);
  if (!sale) return { ok: true };
  await db.query('DELETE FROM customer_sales WHERE id = $1', [Number(saleId)]);
  await _refreshAggregates(sale.customer_id);
  return { ok: true };
}

// ---------- remarks ----------------------------------------------------

async function api_customers_addRemark(token, customerId, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.remark) throw new Error('Remark text required');
  const id = await db.insert('customer_remarks', {
    customer_id: Number(customerId),
    user_id: me.id,
    remark: String(p.remark).trim(),
    remark_type: p.remark_type || 'note',
    created_at: db.nowIso()
  });
  await db.update('customers', customerId, { updated_at: db.nowIso() });
  return { ok: true, id };
}

// ---------- renewals report -------------------------------------------

/**
 * Customers whose subscription is due to expire in the next N days.
 * Used by the dashboard tile + the Renewals tab.
 */
async function api_customers_renewalsDue(token, withinDays) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const days = Number(withinDays) || 30;
  const cutoff = new Date(Date.now() + days * 86400000).toISOString();
  const customers = (await db.getAll('customers'))
    .filter(c => _isVisibleSync(me, visible, c))
    .filter(c => c.next_renewal_at && String(c.next_renewal_at) <= cutoff)
    .sort((a, b) => String(a.next_renewal_at).localeCompare(String(b.next_renewal_at)));
  const usersById = await _userMap();
  return customers.map(c => _hydrate(c, usersById));
}

// ---------- bulk WhatsApp send to selected customers ------------------

/**
 * Fire an approved WhatsApp template to every selected customer in one
 * shot. Bypasses the campaign queue (we have a bounded list, not a
 * filter), so:
 *   - sends sequentially with a 200ms gap to stay under Meta rate limits
 *   - logs each send into customer_remarks of type 'whatsapp' for the
 *     post-sale audit trail
 *   - reuses _sendTemplate so whatsapp_messages + tat logging come
 *     for free and the messages show up in the per-lead chat thread
 *     (when the customer's phone matches a lead phone).
 *
 * Variables support per-customer merge tokens via @{name},
 * @{firstname}, @{phone}, @{email} — same renderer the lead campaigns
 * use, just sourcing the merge data from the customer record.
 */
async function api_customers_bulkWhatsApp(token, customerIds, templateName, language, variables) {
  const me = await authUser(token);
  if (!Array.isArray(customerIds) || !customerIds.length) {
    throw new Error('customerIds required');
  }
  if (!templateName) throw new Error('templateName required');
  const wb = require('./whatsbot');
  const customers = await db.getAll('customers');
  const targets = customerIds.map(id => customers.find(c => Number(c.id) === Number(id))).filter(Boolean);
  let sent = 0, failed = 0;
  const errors = [];
  for (const c of targets) {
    const phone = c.whatsapp || c.phone;
    if (!phone) { failed++; errors.push({ customer_id: c.id, error: 'no phone' }); continue; }
    // Render @{merge} tokens against the customer record
    const renderedVars = (variables || []).map(v =>
      wb._renderMerge(typeof v === 'string' ? v : (v.value || ''), c, { phone, name: c.name })
    );
    try {
      const r = await wb._sendTemplate({
        to: phone, templateName, language: language || 'en_US',
        variables: renderedVars, imageUrl: null,
        leadId: c.from_lead_id || null, userId: me.id
      });
      if (r.body?.error) {
        failed++;
        errors.push({ customer_id: c.id, error: r.body.error.message });
      } else {
        sent++;
        // Audit trail on the customer
        await db.insert('customer_remarks', {
          customer_id: c.id, user_id: me.id,
          remark: '📤 WhatsApp template sent: ' + templateName,
          remark_type: 'whatsapp',
          created_at: db.nowIso()
        });
      }
    } catch (e) {
      failed++;
      errors.push({ customer_id: c.id, error: e.message });
    }
    // Stay polite to Meta: 5 msgs/sec is well within the free quota.
    await new Promise(r => setTimeout(r, 200));
  }
  return { ok: true, sent, failed, total: targets.length, errors: errors.slice(0, 20) };
}

// ---------- reports ----------------------------------------------------

/**
 * Aggregate stats for the Customer Reports view.
 * Computed in JS over the in-memory rows so the function doesn't need
 * Postgres-specific window functions; on a 50k-customer database this
 * still runs in well under a second.
 */
async function api_customers_reports(token, opts) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const o = opts || {};
  const monthsBack = Number(o.months_back) || 12;

  const customers = (await db.getAll('customers'))
    .filter(c => _isVisibleSync(me, visible, c));
  const sales = await db.getAll('customer_sales');
  const customersById = Object.fromEntries(customers.map(c => [Number(c.id), c]));
  // Filter sales to only those belonging to visible customers
  const visSales = sales.filter(s => customersById[Number(s.customer_id)]);

  // ---- Top-line KPIs ---------------------------------------------------
  const totalCustomers = customers.length;
  const activeCustomers = customers.filter(c => c.status === 'active').length;
  const lapsedCustomers = customers.filter(c => c.status === 'lapsed').length;
  const churnedCustomers = customers.filter(c => c.status === 'churned').length;
  const totalLifetime = customers.reduce((s, c) => s + Number(c.lifetime_value || 0), 0);
  const avgLifetime = totalCustomers ? totalLifetime / totalCustomers : 0;

  // ---- MRR (Monthly Recurring Revenue) --------------------------------
  // For every ACTIVE sale row with a subscription_start/end, prorate
  // amount over the subscription duration in months. Sum across all
  // active sales = current MRR. Easy to grasp, accurate enough.
  const today = new Date();
  let mrr = 0;
  for (const s of visSales) {
    if (s.status !== 'active') continue;
    if (!s.subscription_start || !s.subscription_end) continue;
    const start = new Date(s.subscription_start);
    const end = new Date(s.subscription_end);
    // Skip subscriptions whose window has already ended
    if (end < today) continue;
    const months = Math.max(1, Math.round((end - start) / (30 * 86400000)));
    mrr += (Number(s.amount) || 0) / months;
  }

  // ---- Renewal rate (last 90 days) ------------------------------------
  // Of the subs whose subscription_end fell in the last 90 days, what %
  // was followed by another sale (renewal type) for the same customer
  // within ±30 days of that end date?
  const window = 90 * 86400000;
  const cutoff = new Date(today.getTime() - window);
  const expiredRecently = visSales.filter(s =>
    s.subscription_end &&
    new Date(s.subscription_end) >= cutoff &&
    new Date(s.subscription_end) <= today
  );
  let renewed = 0;
  for (const s of expiredRecently) {
    const endTs = new Date(s.subscription_end).getTime();
    const hasRenewal = visSales.some(other =>
      other.id !== s.id &&
      Number(other.customer_id) === Number(s.customer_id) &&
      other.sale_type === 'renewal' &&
      Math.abs(new Date(other.sold_at).getTime() - endTs) <= 30 * 86400000
    );
    if (hasRenewal) renewed++;
  }
  const renewalRate = expiredRecently.length ? (renewed / expiredRecently.length) : null;

  // ---- Top 10 customers by lifetime value -----------------------------
  const usersById = await _userMap();
  const topByLtv = [...customers]
    .sort((a, b) => Number(b.lifetime_value || 0) - Number(a.lifetime_value || 0))
    .slice(0, 10)
    .map(c => Object.assign({}, c, {
      assigned_name: usersById[Number(c.assigned_to)]?.name || ''
    }));

  // ---- Sales by month (last N months) ---------------------------------
  const byMonth = {};
  for (const s of visSales) {
    const m = String(s.sold_at || '').slice(0, 7);
    if (!m) continue;
    byMonth[m] = byMonth[m] || { month: m, count: 0, amount: 0, new: 0, renewal: 0, upgrade: 0, cross_sell: 0 };
    byMonth[m].count++;
    byMonth[m].amount += Number(s.amount) || 0;
    if (s.sale_type) byMonth[m][s.sale_type] = (byMonth[m][s.sale_type] || 0) + 1;
  }
  const salesByMonth = Object.values(byMonth)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-monthsBack);

  // ---- Sales by product ----------------------------------------------
  const byProduct = {};
  for (const s of visSales) {
    const key = s.product_name || 'Unknown';
    byProduct[key] = byProduct[key] || { product: key, count: 0, amount: 0 };
    byProduct[key].count++;
    byProduct[key].amount += Number(s.amount) || 0;
  }
  const salesByProduct = Object.values(byProduct)
    .sort((a, b) => b.amount - a.amount);

  // ---- Sales by rep --------------------------------------------------
  const byRep = {};
  for (const s of visSales) {
    const u = usersById[Number(s.sold_by)];
    const key = u ? u.name : 'Unassigned';
    byRep[key] = byRep[key] || { rep: key, count: 0, amount: 0 };
    byRep[key].count++;
    byRep[key].amount += Number(s.amount) || 0;
  }
  const salesByRep = Object.values(byRep)
    .sort((a, b) => b.amount - a.amount);

  // ---- New customers per month ---------------------------------------
  const newByMonth = {};
  for (const c of customers) {
    const m = String(c.customer_since || c.created_at || '').slice(0, 7);
    if (!m) continue;
    newByMonth[m] = (newByMonth[m] || 0) + 1;
  }
  const customerGrowth = Object.entries(newByMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-monthsBack)
    .map(([month, count]) => ({ month, count }));

  // ---- Renewals due summary ------------------------------------------
  const due7  = customers.filter(c => c.next_renewal_at && _withinDays(c.next_renewal_at, 7)).length;
  const due30 = customers.filter(c => c.next_renewal_at && _withinDays(c.next_renewal_at, 30)).length;
  const due90 = customers.filter(c => c.next_renewal_at && _withinDays(c.next_renewal_at, 90)).length;

  return {
    kpis: {
      total_customers: totalCustomers,
      active: activeCustomers,
      lapsed: lapsedCustomers,
      churned: churnedCustomers,
      total_lifetime: Math.round(totalLifetime),
      avg_lifetime: Math.round(avgLifetime),
      mrr: Math.round(mrr),
      renewal_rate: renewalRate,
      renewals_expired_window: expiredRecently.length,
      renewals_renewed: renewed,
      renewals_due_7d: due7,
      renewals_due_30d: due30,
      renewals_due_90d: due90
    },
    top_by_ltv: topByLtv,
    sales_by_month: salesByMonth,
    sales_by_product: salesByProduct,
    sales_by_rep: salesByRep,
    customer_growth: customerGrowth
  };
}

function _withinDays(iso, days) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return false;
  const now = Date.now();
  const cutoff = now + days * 86400000;
  return t >= now && t <= cutoff;
}

module.exports = {
  api_customers_list, api_customers_get,
  api_customers_create, api_customers_convertFromLead,
  api_customers_update, api_customers_delete,
  api_customers_addSale, api_customers_updateSale, api_customers_deleteSale,
  api_customers_addRemark,
  api_customers_renewalsDue,
  api_customers_bulkWhatsApp,
  api_customers_reports
};
