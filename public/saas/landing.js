/**
 * Public landing page — pricing grid + signup flow.
 *
 * Flow:
 *   1. fetch /api/saas — list packages, render grid
 *   2. user clicks "Get started" → open modal pre-filled with package
 *   3. submit form → /api/saas calls api_saas_signup_create
 *   4. response gives a Cashfree payment_session_id → launch checkout
 *   5. on return / webhook, tenant is provisioned + user gets login URL
 */
const $ = sel => document.querySelector(sel);

async function api(fn, args) {
  const r = await fetch('/api/saas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fn, args: args ? [args] : [] })
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'API error');
  return j.result;
}

async function loadBranding() {
  try {
    const r = await fetch('/api/saas/brand').then(r => r.json());
    $('#hero-title').textContent = r.tagline || 'The CRM your sales team will actually use';
    $('#hero-sub').textContent = r.subhead || 'Capture leads, auto-dial, AI call summaries, WhatsApp at scale, and follow-up reminders that never let a deal slip — all in one place.';
    document.title = (r.name || 'SmartCRM') + ' — ' + (r.tagline || '');
  } catch (_) {
    $('#hero-title').textContent = 'The CRM your sales team will actually use';
  }
}

function rupeesPretty(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function periodLabel(pkg) {
  const c = Number(pkg.recurring_period_count || 1);
  const p = pkg.recurring_period || 'month';
  if (Number(pkg.is_lifetime) === 1) return 'lifetime';
  if (c === 1) return 'per ' + p;
  return 'per ' + c + ' ' + p + 's';
}

function userLimit(pkg) {
  try {
    const q = typeof pkg.quotas === 'string' ? JSON.parse(pkg.quotas) : (pkg.quotas || {});
    if (q && q.users && q.users.limit !== undefined) {
      return Number(q.users.limit) === -1 ? '∞' : q.users.limit;
    }
  } catch (_) {}
  return null;
}

async function loadPackages() {
  const grid = $('#pricing-grid');
  let pkgs;
  try { pkgs = await api('api_saas_packages_publicList'); }
  catch (e) { grid.innerHTML = '<div class="loading">Could not load plans: ' + e.message + '</div>'; return; }
  if (!pkgs.length) { grid.innerHTML = '<div class="loading">No plans available yet.</div>'; return; }
  grid.innerHTML = '';
  pkgs.forEach(pkg => {
    const card = document.createElement('div');
    card.className = 'pricing-card' + (Number(pkg.is_most_popular) === 1 ? ' popular' : '');
    const users = userLimit(pkg);
    card.innerHTML = `
      ${Number(pkg.is_most_popular) === 1 ? '<div class="popular-badge">★ Most Popular</div>' : ''}
      <h3>${escape(pkg.name)}</h3>
      <div class="price">${rupeesPretty(pkg.base_price_inr)}<span class="per"> ${escape(periodLabel(pkg))}</span></div>
      ${users != null ? `<div class="users-pill">${users} user${users === 1 ? '' : 's'}</div>` : ''}
      <div class="package-desc">${pkg.description || ''}</div>
      <button class="btn-outline" data-id="${pkg.id}">Get started →</button>
    `;
    card.querySelector('button').addEventListener('click', () => openSignup(pkg));
    grid.appendChild(card);
  });
}

function escape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

let currentPkg = null;
function openSignup(pkg) {
  currentPkg = pkg;
  $('#su-pkg').textContent = pkg.name + ' plan';
  const tax = Math.round(Number(pkg.base_price_inr) * Number(pkg.tax_percent || 0) / 100);
  const total = Number(pkg.base_price_inr) + tax;
  $('#su-price').innerHTML =
    rupeesPretty(pkg.base_price_inr) +
    (tax > 0 ? ' <span class="muted">+ ' + rupeesPretty(tax) + ' GST</span>' : '') +
    ' = <b>' + rupeesPretty(total) + '</b> ' + escape(periodLabel(pkg));
  $('#signup-modal').hidden = false;
  setTimeout(() => $('#signup-modal').querySelector('input[name=name]').focus(), 50);
}
function closeSignup() { $('#signup-modal').hidden = true; }
window.closeSignup = closeSignup;

async function submitSignup(ev) {
  ev.preventDefault();
  const btn = $('#signup-btn');
  btn.disabled = true; btn.textContent = 'Creating order…';
  const form = ev.target;
  const payload = {
    name:   form.name.value.trim(),
    email:  form.email.value.trim(),
    mobile: form.mobile.value.trim(),
    org_name: form.org_name.value.trim(),
    desired_slug: form.desired_slug.value.trim().toLowerCase(),
    package_id: currentPkg.id
  };
  try {
    const r = await api('api_saas_signup_create', payload);
    if (r.free) {
      // Free plan provisioned directly
      window.location = r.login_url || ('/t/' + r.slug);
      return;
    }
    // Launch Cashfree Hosted Checkout
    const cf = window.Cashfree({ mode: 'production' });
    cf.checkout({
      paymentSessionId: r.payment_session_id,
      redirectTarget: '_self'
    });
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Continue to payment →';
    alert('Could not create order: ' + e.message);
  }
}
window.submitSignup = submitSignup;

// Boot
loadBranding();
loadPackages();
