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

/**
 * Send a client error to the platform error log. Best-effort —
 * silently swallows transport failures so a logging failure never
 * cascades into a second visible error for the user. Throttled
 * client-side so a runaway loop can't DOS our own /log-error
 * endpoint.
 */
let _lastErrLogAt = 0;
async function logClientError(payload) {
  const now = Date.now();
  if (now - _lastErrLogAt < 1000) return;        // 1 / sec max
  _lastErrLogAt = now;
  try {
    await fetch('/api/saas/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keepalive lets the request finish even if the page is
      // navigating away (e.g. when the error is from a button that
      // immediately redirects).
      keepalive: true,
      body: JSON.stringify(Object.assign({
        url: location.href,
        ua: navigator.userAgent,
        source: 'landing',
        ts_iso: new Date().toISOString()
      }, payload || {}))
    });
  } catch (_) { /* swallow */ }
}
window.logClientError = logClientError;

// Catch absolutely anything that bubbles up — uncaught throws and
// rejected promises both get logged with stack/file/line. The user
// asked us to capture every error in our project; this is the net.
window.addEventListener('error', ev => {
  try {
    logClientError({
      message: (ev.error && ev.error.message) || ev.message || 'window.error',
      stack:   (ev.error && ev.error.stack)   || null,
      file:    ev.filename || null,
      line:    ev.lineno   || null,
      col:     ev.colno    || null,
      severity: 'error'
    });
  } catch (_) {}
});
window.addEventListener('unhandledrejection', ev => {
  try {
    const reason = ev.reason || {};
    logClientError({
      message: (reason && reason.message) || String(reason) || 'unhandledrejection',
      stack:   (reason && reason.stack)   || null,
      severity: 'error'
    });
  } catch (_) {}
});

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
  const setBtn = (txt, dis) => { btn.textContent = txt; btn.disabled = !!dis; };
  // Guard: if the user somehow reached the form without a selected
  // plan (refreshed mid-flow, multiple tabs, racing click handlers),
  // currentPkg will be null. Instead of a cryptic null-deref, close
  // the modal gracefully and ask them to re-pick a plan. We also log
  // it so it shows up in the platform error log.
  if (!currentPkg || !currentPkg.id) {
    setBtn('Continue to payment →', false);
    alert('Please pick a plan before continuing. Closing this dialog — tap "Get started" on the plan you want.');
    closeSignup();
    try {
      logClientError({
        message: 'submitSignup invoked with no selected package',
        source: 'landing'
      });
    } catch (_) {}
    return;
  }
  setBtn('Creating order…', true);
  const form = ev.target;
  const payload = {
    name:   form.name.value.trim(),
    email:  form.email.value.trim(),
    mobile: form.mobile.value.trim(),
    org_name: form.org_name.value.trim(),
    desired_slug: form.desired_slug.value.trim().toLowerCase(),
    package_id: currentPkg.id
  };

  let r;
  try {
    r = await api('api_saas_signup_create', payload);
  } catch (e) {
    setBtn('Continue to payment →', false);
    alert('Could not create order: ' + (e.message || e));
    return;
  }

  // Free / ₹0 plan — provisioned directly
  if (r.free) {
    setBtn('✓ Created — redirecting…', true);
    window.location = r.login_url || ('/t/' + r.slug);
    return;
  }

  if (!r.payment_session_id) {
    setBtn('Continue to payment →', false);
    alert('Server returned no payment session. Please try again or contact support.');
    return;
  }

  setBtn('Opening payment…', true);

  // Wait briefly for the Cashfree SDK to load if it's still in flight.
  // The SDK script tag is in the <head> but can be slow on cold mobile
  // networks; we poll up to 5 seconds before giving up.
  const waitForCashfree = async () => {
    for (let i = 0; i < 50; i++) {
      if (typeof window.Cashfree === 'function') return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return typeof window.Cashfree === 'function';
  };
  const ready = await waitForCashfree();
  if (!ready) {
    setBtn('Continue to payment →', false);
    alert('Payment SDK failed to load. This is usually caused by an ad blocker or restrictive network. Please disable your ad blocker for this site or try a different browser.');
    return;
  }

  try {
    const cf = window.Cashfree({ mode: 'production' });
    const result = cf.checkout({
      paymentSessionId: r.payment_session_id,
      redirectTarget: '_self'
    });
    // SDK v3 returns a Promise; older fire-and-forget variants don't.
    if (result && typeof result.then === 'function') {
      const out = await result;
      if (out && out.error) {
        setBtn('Continue to payment →', false);
        alert('Payment error: ' + (out.error.message || JSON.stringify(out.error)));
        return;
      }
      // result.redirect = true means the SDK is taking us off-page
    }
    // If we're still here after 8s the SDK likely silently failed —
    // surface that to the user instead of leaving them stuck.
    setTimeout(() => {
      if (document.visibilityState === 'visible' && location.pathname === '/') {
        setBtn('Continue to payment →', false);
        const dbg = h('div', { class: 'muted', style: { fontSize: '.8rem', marginTop: '.5rem' } },
          'Order ' + r.order_id + ' was created but the payment window did not open. Save your order ID — you can complete payment from /signup/return?order_id=' + r.order_id + ' once the issue is resolved.'
        );
        $('#signup-form').appendChild(dbg);
      }
    }, 8000);
  } catch (e) {
    console.error('[signup] Cashfree SDK threw:', e);
    setBtn('Continue to payment →', false);
    alert('Could not open payment window: ' + (e.message || e) + '\n\nYour order ID is ' + r.order_id + ' — keep it for support.');
  }
}
window.submitSignup = submitSignup;
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v);
  }
  kids.flat(Infinity).forEach(k => {
    if (k == null || k === false) return;
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  });
  return el;
}

// Boot
loadBranding();
loadPackages();
