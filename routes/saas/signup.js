/**
 * Public signup + tenant provisioning.
 *
 *   api_saas_signup_create({ name, email, mobile, org_name, package_id })
 *     - Validates inputs
 *     - Generates a unique slug from org_name
 *     - Creates a `signups` row
 *     - Creates a Cashfree order
 *     - Returns { payment_session_id, order_id } so the frontend can
 *       launch Cashfree Hosted Checkout
 *
 *   provisionTenant(signupId)  [internal — called by webhook on payment success]
 *     - Creates the tenant DB
 *     - Runs the CRM schema on it
 *     - Seeds the admin user with a random password
 *     - Inserts into `tenants` table
 *     - Issues the first invoice
 *     - Emails the credentials to the customer
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const control = require('../../control/db');
const cashfree = require('./cashfree');
const provisioning = require('./provisioning');

const SLUG_RX = /^[a-z][a-z0-9-]{2,29}$/;

function _slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28) || ('org' + Math.random().toString(36).slice(2, 8));
}

async function _uniqueSlug(base) {
  let candidate = base;
  for (let i = 0; i < 50; i++) {
    const exists = await control.findOneBy('tenants', 'slug', candidate);
    const reserved = ['admin', 'api', 't', 'home', 'pricing', 'signup', 'login', 'hook', 'public', 'static'].includes(candidate);
    if (!exists && !reserved && SLUG_RX.test(candidate)) return candidate;
    candidate = base + '-' + Math.random().toString(36).slice(2, 6);
  }
  throw new Error('Could not generate a unique slug — try a different org name');
}

async function api_saas_signup_create(_token, payload) {
  const p = payload || {};
  const name   = String(p.name   || '').trim();
  const email  = String(p.email  || '').toLowerCase().trim();
  const mobile = String(p.mobile || '').replace(/\D/g, '');
  const orgName = String(p.org_name || name).trim();
  if (!name)  throw new Error('Name is required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Valid email required');
  if (mobile.length < 10) throw new Error('Mobile must be at least 10 digits');
  if (!orgName) throw new Error('Organisation name is required');

  const pkg = await control.findById('packages', Number(p.package_id));
  if (!pkg || Number(pkg.is_enabled) === 0) throw new Error('Invalid package');

  // Slug
  const desired = SLUG_RX.test(p.desired_slug || '') ? p.desired_slug : _slugify(orgName);
  const slug = await _uniqueSlug(desired);

  // Compute amount — base + tax
  const base = Number(pkg.base_price_inr) || 0;
  const tax  = Math.round((base * Number(pkg.tax_percent || 0) / 100) * 100) / 100;
  const total = Math.round((base + tax) * 100) / 100;

  // Persist the signup BEFORE creating the order so we can recover from
  // a Cashfree-API failure without creating duplicate orders later.
  const signupId = await control.insert('signups', {
    name, email, mobile, org_name: orgName,
    package_id: pkg.id,
    desired_slug: slug,
    status: 'pending',
    metadata: JSON.stringify({ base, tax, total })
  });

  // Create the Cashfree order
  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
  const orderId = 'SCO-' + signupId + '-' + crypto.randomBytes(4).toString('hex');
  let cf;
  if (Number(total) <= 0) {
    // Free / ₹0 plan — provision immediately, no Cashfree round-trip
    await control.update('signups', signupId, { status: 'paid', cashfree_order_id: orderId });
    const result = await provisioning.provisionFromSignup(signupId);
    return { free: true, slug: result.slug, login_url: baseUrl + '/t/' + result.slug, ...result };
  }

  try {
    cf = await cashfree.createOrder({
      orderId,
      amountInr: total,
      customerName: name,
      customerEmail: email,
      customerPhone: mobile,
      returnUrl: baseUrl + '/signup/return?order_id=' + orderId,
      notifyUrl: baseUrl + '/hook/cashfree'
    });
  } catch (e) {
    await control.update('signups', signupId, { status: 'abandoned', metadata: JSON.stringify({ error: e.message }) });
    throw new Error('Payment gateway error: ' + e.message);
  }

  await control.update('signups', signupId, { cashfree_order_id: orderId });
  await control.insert('audit_log', {
    actor_type: 'system', event: 'signup.created',
    detail: JSON.stringify({ signup_id: signupId, email, package: pkg.name, total })
  });

  return {
    payment_session_id: cf.payment_session_id,
    order_id: orderId,
    cf_order_id: cf.cf_order_id,
    amount_inr: total
  };
}

/**
 * After the customer returns from Cashfree, the frontend can call this
 * to verify status (in case the webhook hasn't fired yet).
 */
async function api_saas_signup_verify(_token, orderId) {
  if (!orderId) throw new Error('order_id required');
  const signup = await control.findOneBy('signups', 'cashfree_order_id', orderId);
  if (!signup) throw new Error('Unknown order');
  // Already provisioned → return tenant slug
  if (signup.status === 'provisioned') {
    const t = await control.findOneBy('tenants', 'slug', signup.desired_slug);
    if (t) return { provisioned: true, slug: t.slug, status: t.status };
  }
  // Otherwise, poll Cashfree once
  const cf = await cashfree.getOrderStatus(orderId);
  const orderStatus = String(cf.order_status || '').toUpperCase();
  if (orderStatus === 'PAID') {
    const result = await provisioning.provisionFromSignup(signup.id);
    return { provisioned: true, slug: result.slug, status: 'active' };
  }
  return { provisioned: false, status: orderStatus.toLowerCase() };
}

module.exports = {
  api_saas_signup_create,
  api_saas_signup_verify,
  _slugify, _uniqueSlug
};
