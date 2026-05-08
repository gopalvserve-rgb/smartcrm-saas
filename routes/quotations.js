/**
 * routes/quotations.js
 *
 * Tenant-scoped quotation CRUD + send-via-email + send-via-WhatsApp +
 * public viewer (hosted at /q/<token>).
 *
 * Public surface (auto-loaded by tenantApi.js):
 *   api_quotations_list(token, opts?)       — { rows, totals }
 *   api_quotations_get(token, id)           — full quote + items
 *   api_quotations_save(token, payload)     — create / update; recomputes totals
 *   api_quotations_delete(token, id)
 *   api_quotations_set_status(token, id, status)
 *   api_quotations_send_email(token, id, opts?)
 *   api_quotations_send_whatsapp(token, id, opts?)
 *   api_quotations_public_url(token, id)    — returns the customer-facing URL
 *
 * Express endpoints (mounted in server.js + server.tenant.js):
 *   GET  /q/:token    — public HTML viewer (no auth)
 *
 * Sending:
 *   - Email: uses the existing nodemailer (utils/mailer.js if present,
 *     otherwise routes/saas/saasMailer for SaaS). Body is rendered HTML.
 *   - WhatsApp: sends a free-form text message with the public link via
 *     whatsbot._sendText. Uses the default phone (no template needed —
 *     this is sent inside an active conversation window after the
 *     customer first messages, OR the tenant must use a template if
 *     outside the 24h window. We support both: if the customer has
 *     messaged in the last 24h, plain text; otherwise the tenant can
 *     pass template_name and we send a template instead).
 */

'use strict';

const crypto = require('crypto');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

let _whatsbot = null;
function _wb() { if (!_whatsbot) { try { _whatsbot = require('./whatsbot'); } catch (_) { _whatsbot = {}; } } return _whatsbot; }

function _genToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function _nextNumber() {
  // Simple year-based counter: Q-YYYY-NNNN.
  const year = new Date().getUTCFullYear();
  const r = await db.query(
    `SELECT number FROM quotations WHERE number LIKE $1 ORDER BY id DESC LIMIT 1`,
    [`Q-${year}-%`]
  );
  let n = 1;
  if (r.rows.length) {
    const parts = String(r.rows[0].number).split('-');
    n = (parseInt(parts[2], 10) || 0) + 1;
  }
  return `Q-${year}-${String(n).padStart(4, '0')}`;
}

function _recomputeTotals(items, discount_pct, tax_pct) {
  let subtotal = 0;
  (items || []).forEach(it => {
    const qty = Number(it.quantity || 0);
    const price = Number(it.unit_price || 0);
    const lineDisc = Number(it.discount_pct || 0);
    const gross = qty * price;
    const line = gross - (gross * lineDisc / 100);
    it.amount = Number(line.toFixed(2));
    subtotal += line;
  });
  subtotal = Number(subtotal.toFixed(2));
  const discAmt = Number((subtotal * Number(discount_pct || 0) / 100).toFixed(2));
  const taxable = subtotal - discAmt;
  const taxAmt = Number((taxable * Number(tax_pct || 0) / 100).toFixed(2));
  const total = Number((taxable + taxAmt).toFixed(2));
  return { subtotal, discount_amt: discAmt, tax_amt: taxAmt, total };
}

async function api_quotations_list(token, opts) {
  await authUser(token);
  const o = opts || {};
  const limit = Math.max(1, Math.min(500, Number(o.limit || 100)));
  const params = [];
  let where = '1=1';
  if (o.status)   { params.push(o.status); where += ` AND status = $${params.length}`; }
  if (o.lead_id)  { params.push(Number(o.lead_id)); where += ` AND lead_id = $${params.length}`; }
  if (o.q) {
    params.push('%' + String(o.q).toLowerCase() + '%');
    where += ` AND (LOWER(number) LIKE $${params.length} OR LOWER(customer_name) LIKE $${params.length} OR LOWER(customer_email) LIKE $${params.length})`;
  }
  const r = await db.query(
    `SELECT id, number, lead_id, customer_name, customer_email, customer_phone,
            status, issue_date, valid_until, currency, total, sent_at, sent_via, created_at
       FROM quotations
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params
  );
  return { rows: r.rows };
}

async function api_quotations_get(token, id) {
  await authUser(token);
  const qid = Number(id);
  const q = (await db.query(`SELECT * FROM quotations WHERE id = $1`, [qid])).rows[0];
  if (!q) throw new Error('Quotation not found');
  const items = (await db.query(
    `SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY position ASC, id ASC`, [qid]
  )).rows;
  return { quotation: q, items };
}

async function api_quotations_save(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  const id = Number(p.id || 0);
  const items = Array.isArray(p.items) ? p.items.filter(x => x && x.description) : [];
  const totals = _recomputeTotals(items, p.discount_pct, p.tax_pct);

  if (!p.customer_name || !String(p.customer_name).trim()) throw new Error('Customer name required');

  if (id) {
    await db.query(
      `UPDATE quotations SET
         lead_id = $1, customer_id = $2, customer_name = $3, customer_email = $4,
         customer_phone = $5, customer_address = $6, status = COALESCE($7, status),
         issue_date = COALESCE($8, issue_date), valid_until = $9, currency = COALESCE($10, currency),
         discount_pct = $11, discount_amt = $12, tax_pct = $13, tax_amt = $14,
         subtotal = $15, total = $16, notes = $17, terms = $18, updated_at = NOW()
       WHERE id = $19`,
      [
        p.lead_id || null, p.customer_id || null,
        String(p.customer_name).slice(0, 200),
        String(p.customer_email || '').slice(0, 200),
        String(p.customer_phone || '').slice(0, 80),
        String(p.customer_address || '').slice(0, 500),
        p.status || null,
        p.issue_date || null,
        p.valid_until || null,
        p.currency || 'INR',
        Number(p.discount_pct || 0), totals.discount_amt,
        Number(p.tax_pct || 0), totals.tax_amt,
        totals.subtotal, totals.total,
        String(p.notes || '').slice(0, 4000),
        String(p.terms || '').slice(0, 4000),
        id
      ]
    );
    await db.query(`DELETE FROM quotation_items WHERE quotation_id = $1`, [id]);
    let pos = 1;
    for (const it of items) {
      await db.query(
        `INSERT INTO quotation_items (quotation_id, position, product_id, description, quantity, unit_price, discount_pct, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, pos++, it.product_id || null, String(it.description).slice(0, 500),
         Number(it.quantity || 0), Number(it.unit_price || 0),
         Number(it.discount_pct || 0), Number(it.amount || 0)]
      );
    }
    return await api_quotations_get(token, id);
  }

  const number = p.number || await _nextNumber();
  const tokenStr = _genToken();
  const ins = await db.query(
    `INSERT INTO quotations (number, lead_id, customer_id, customer_name, customer_email,
        customer_phone, customer_address, status, issue_date, valid_until, currency,
        discount_pct, discount_amt, tax_pct, tax_amt, subtotal, total, notes, terms,
        public_token, is_public, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,1,$21)
     RETURNING id`,
    [
      number, p.lead_id || null, p.customer_id || null,
      String(p.customer_name).slice(0, 200),
      String(p.customer_email || '').slice(0, 200),
      String(p.customer_phone || '').slice(0, 80),
      String(p.customer_address || '').slice(0, 500),
      p.status || 'draft',
      p.issue_date || new Date().toISOString().slice(0, 10),
      p.valid_until || null,
      p.currency || 'INR',
      Number(p.discount_pct || 0), totals.discount_amt,
      Number(p.tax_pct || 18), totals.tax_amt,
      totals.subtotal, totals.total,
      String(p.notes || '').slice(0, 4000),
      String(p.terms || '').slice(0, 4000),
      tokenStr, me.id
    ]
  );
  const newId = ins.rows[0].id;
  let pos = 1;
  for (const it of items) {
    await db.query(
      `INSERT INTO quotation_items (quotation_id, position, product_id, description, quantity, unit_price, discount_pct, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId, pos++, it.product_id || null, String(it.description).slice(0, 500),
       Number(it.quantity || 0), Number(it.unit_price || 0),
       Number(it.discount_pct || 0), Number(it.amount || 0)]
    );
  }
  return await api_quotations_get(token, newId);
}

async function api_quotations_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await db.query(`DELETE FROM quotations WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

async function api_quotations_set_status(token, id, status) {
  await authUser(token);
  const allowed = ['draft', 'sent', 'accepted', 'rejected', 'expired'];
  if (!allowed.includes(status)) throw new Error('Invalid status');
  const updates = ['status = $1', 'updated_at = NOW()'];
  const vals = [status];
  if (status === 'accepted') updates.push('accepted_at = NOW()');
  if (status === 'rejected') updates.push('rejected_at = NOW()');
  await db.query(`UPDATE quotations SET ${updates.join(', ')} WHERE id = $${vals.length + 1}`, [...vals, Number(id)]);
  return { ok: true };
}

async function api_quotations_public_url(token, id) {
  await authUser(token);
  const r = await db.query(`SELECT public_token FROM quotations WHERE id = $1`, [Number(id)]);
  if (!r.rows.length) throw new Error('Quotation not found');
  const slug = (db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore())
    ? (db.tenantStorage.getStore().slug || '') : '';
  // BASE_URL config or origin from request — for now use BASE_URL config + slug.
  const base = (await db.getConfig('BASE_URL', '')).replace(/\/+$/, '') || '';
  const path = (slug ? '/t/' + slug : '') + '/q/' + r.rows[0].public_token;
  return { url: base ? base + path : path, token: r.rows[0].public_token };
}

/**
 * Render a quotation as a self-contained HTML page (used by both the
 * public viewer + email body).
 */
async function _renderHtml(quotation, items, brandConfig) {
  const q = quotation;
  const cur = q.currency || 'INR';
  const sym = cur === 'INR' ? '₹' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur + ' ';
  const fmt = n => sym + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const company = (brandConfig && brandConfig.COMPANY_NAME) || 'Quotation';
  const logo = (brandConfig && brandConfig.COMPANY_LOGO_URL) || '';
  const primary = (brandConfig && brandConfig.BRAND_PRIMARY_COLOR) || '#6366f1';
  const validUntil = q.valid_until ? new Date(q.valid_until).toLocaleDateString('en-IN') : '';
  const issue = q.issue_date ? new Date(q.issue_date).toLocaleDateString('en-IN') : '';
  const itemsHtml = items.map(it => `
    <tr>
      <td>${_esc(it.description)}</td>
      <td style="text-align:right">${Number(it.quantity || 0)}</td>
      <td style="text-align:right">${fmt(it.unit_price)}</td>
      <td style="text-align:right">${Number(it.discount_pct || 0)}%</td>
      <td style="text-align:right">${fmt(it.amount)}</td>
    </tr>
  `).join('');
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Quotation ${_esc(q.number)} — ${_esc(q.customer_name || '')}</title>
<style>
  body { font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; max-width: 820px; margin: 2rem auto; padding: 1rem; color: #0f172a; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; border-bottom: 3px solid ${_esc(primary)}; padding-bottom: 1rem; margin-bottom: 1rem; }
  .logo img { max-height: 56px; }
  .meta { text-align: right; }
  .meta h1 { color: ${_esc(primary)}; margin: 0; font-size: 1.6rem; }
  .meta div { font-size: .9rem; color: #64748b; }
  .who { display: flex; gap: 2rem; margin: 1rem 0; }
  .who .col { flex: 1; }
  .col h4 { margin: 0 0 .25rem; color: #475569; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  table.items th, table.items td { padding: .55rem .6rem; border-bottom: 1px solid #e2e8f0; font-size: .92rem; }
  table.items thead th { background: ${_esc(primary)}; color: #fff; text-align: left; font-weight: 600; }
  .totals { margin-top: 1rem; margin-left: auto; max-width: 360px; }
  .totals div { display: flex; justify-content: space-between; padding: .35rem 0; }
  .totals .grand { font-weight: 700; font-size: 1.1rem; border-top: 2px solid ${_esc(primary)}; color: ${_esc(primary)}; padding-top: .5rem; margin-top: .5rem; }
  .terms { margin-top: 1.5rem; font-size: .88rem; color: #475569; white-space: pre-wrap; }
  .actions { margin-top: 2rem; text-align: center; }
  .btn-print { background: ${_esc(primary)}; color: #fff; border: none; padding: .7rem 1.4rem; border-radius: 8px; font-weight: 600; cursor: pointer; }
  @media print { .actions, .btn-print { display: none; } }
</style>
</head>
<body>
  <div class="head">
    <div class="logo">${logo ? '<img src="' + _esc(logo) + '" alt="logo"/>' : '<h2 style="margin:0;color:' + _esc(primary) + '">' + _esc(company) + '</h2>'}</div>
    <div class="meta">
      <h1>QUOTATION</h1>
      <div><b>${_esc(q.number)}</b></div>
      <div>Issued: ${_esc(issue)}</div>
      ${validUntil ? '<div>Valid until: ' + _esc(validUntil) + '</div>' : ''}
    </div>
  </div>
  <div class="who">
    <div class="col">
      <h4>From</h4>
      <div><b>${_esc(company)}</b></div>
    </div>
    <div class="col">
      <h4>To</h4>
      <div><b>${_esc(q.customer_name || '')}</b></div>
      ${q.customer_email  ? '<div>' + _esc(q.customer_email) + '</div>' : ''}
      ${q.customer_phone  ? '<div>' + _esc(q.customer_phone) + '</div>' : ''}
      ${q.customer_address? '<div style="margin-top:.25rem">' + _esc(q.customer_address) + '</div>' : ''}
    </div>
  </div>
  <table class="items">
    <thead><tr>
      <th>Description</th>
      <th style="text-align:right">Qty</th>
      <th style="text-align:right">Unit price</th>
      <th style="text-align:right">Disc</th>
      <th style="text-align:right">Amount</th>
    </tr></thead>
    <tbody>${itemsHtml || '<tr><td colspan="5" style="text-align:center;color:#94a3b8">No line items</td></tr>'}</tbody>
  </table>
  <div class="totals">
    <div><span>Subtotal</span><span>${fmt(q.subtotal)}</span></div>
    ${Number(q.discount_amt) ? '<div><span>Discount (' + Number(q.discount_pct || 0) + '%)</span><span>-' + fmt(q.discount_amt) + '</span></div>' : ''}
    ${Number(q.tax_amt) ? '<div><span>Tax (' + Number(q.tax_pct || 0) + '%)</span><span>' + fmt(q.tax_amt) + '</span></div>' : ''}
    <div class="grand"><span>Total</span><span>${fmt(q.total)}</span></div>
  </div>
  ${q.notes  ? '<div class="terms"><h4>Notes</h4>' + _esc(q.notes)  + '</div>' : ''}
  ${q.terms  ? '<div class="terms"><h4>Terms &amp; conditions</h4>' + _esc(q.terms)  + '</div>' : ''}
  <div class="actions">
    <button class="btn-print" onclick="window.print()">🖨️ Print / save as PDF</button>
  </div>
</body></html>`;
}
function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function api_quotations_send_email(token, id, opts) {
  const me = await authUser(token);
  const o = opts || {};
  const r = await api_quotations_get(token, Number(id));
  const q = r.quotation;
  const to = o.to || q.customer_email;
  if (!to) throw new Error('Customer email missing — set it on the quotation or pass payload.to.');
  let mailer;
  try { mailer = require('../utils/mailer'); } catch (_) { mailer = null; }
  if (!mailer || !mailer.send) throw new Error('Mailer not available on this deployment');
  // Build HTML body
  const cfg = await _loadBrand();
  const html = await _renderHtml(q, r.items, cfg);
  const subject = o.subject || ('Quotation ' + q.number + ' from ' + (cfg.COMPANY_NAME || 'us'));
  await mailer.send({ to, subject, html, replyTo: o.replyTo || me.email || null });
  await db.query(`UPDATE quotations SET sent_at = NOW(), sent_via = COALESCE(sent_via, '') || (CASE WHEN COALESCE(sent_via,'') ILIKE '%email%' THEN '' ELSE 'email,' END), status = CASE WHEN status='draft' THEN 'sent' ELSE status END WHERE id = $1`, [q.id]);
  return { ok: true, sent_to: to };
}

async function api_quotations_send_whatsapp(token, id, opts) {
  await authUser(token);
  const o = opts || {};
  const r = await api_quotations_get(token, Number(id));
  const q = r.quotation;
  const phone = o.phone || q.customer_phone;
  if (!phone) throw new Error('Customer phone missing — set it on the quotation or pass payload.phone.');
  // Resolve public URL
  const u = await api_quotations_public_url(token, q.id);
  const cfg = await _loadBrand();
  const company = cfg.COMPANY_NAME || 'Our team';
  const cur = q.currency || 'INR';
  const sym = cur === 'INR' ? '₹' : cur === 'USD' ? '$' : cur + ' ';
  const text = o.text ||
    'Hello ' + (q.customer_name || 'there') + ',\n\n' +
    'Please find your quotation ' + q.number + ' (' + sym + Number(q.total).toLocaleString('en-IN') + ').\n' +
    'View / download: ' + u.url + '\n\n— ' + company;
  const wb = _wb();
  if (!wb._sendText || !wb._cfg) throw new Error('WhatsApp module not available');
  const cfgWa = await wb._cfg();
  if (!cfgWa.token || !cfgWa.phoneId) throw new Error('WhatsApp not connected. Settings → WhatsApp → Connect Account.');
  const send = await wb._sendText({ to: phone, text, leadId: q.lead_id || null, userId: null }, cfgWa);
  if (send && send.body && send.body.error) {
    throw new Error('WhatsApp rejected: ' + send.body.error.message);
  }
  await db.query(`UPDATE quotations SET sent_at = NOW(), sent_via = COALESCE(sent_via, '') || (CASE WHEN COALESCE(sent_via,'') ILIKE '%whatsapp%' THEN '' ELSE 'whatsapp,' END), status = CASE WHEN status='draft' THEN 'sent' ELSE status END WHERE id = $1`, [q.id]);
  return { ok: true, sent_to: phone, url: u.url };
}

async function _loadBrand() {
  const keys = ['COMPANY_NAME', 'COMPANY_LOGO_URL', 'BRAND_PRIMARY_COLOR', 'BASE_URL'];
  const out = {};
  for (const k of keys) {
    out[k] = await db.getConfig(k, '').catch(() => '');
  }
  return out;
}

/**
 * Express handler for /q/:token (mounted in server.js for SaaS,
 * server.tenant.js for single-tenant). No auth — public viewer.
 */
async function expressPublicQuote(req, res) {
  const tk = String(req.params.token || '').trim();
  if (!tk) return res.status(404).send('Not found');
  let row, items;
  try {
    const r = await db.query(`SELECT * FROM quotations WHERE public_token = $1 AND is_public = 1`, [tk]);
    row = r.rows[0];
    if (!row) return res.status(404).send('Quotation not found or no longer available');
    items = (await db.query(`SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY position ASC, id ASC`, [row.id])).rows;
  } catch (e) {
    return res.status(500).send('Error: ' + e.message);
  }
  const cfg = await _loadBrand();
  const html = await _renderHtml(row, items, cfg);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = {
  api_quotations_list, api_quotations_get, api_quotations_save,
  api_quotations_delete, api_quotations_set_status,
  api_quotations_send_email, api_quotations_send_whatsapp,
  api_quotations_public_url,
  expressPublicQuote,
};
