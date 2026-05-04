/**
 * Lead CRM — v4 frontend
 * Full-featured SPA over POST /api.
 */

const CRM = {
  token: localStorage.getItem('crm_token') || null,
  user: null,
  config: { company_name: 'Lead CRM', company_logo_url: '', base_url: location.origin },
  cache: {},
  prefs: {
    columns: JSON.parse(localStorage.getItem('crm_cols') || '["name","phone","source","status","assigned","followup","last_change","remark","created"]'),
    filters: JSON.parse(localStorage.getItem('crm_filters') || '{}'),
    showHeader: localStorage.getItem('crm_show_header') !== '0'
  }
};

/* ---------------- API helper ---------------- */
// Global "in-flight" counter — drives the top loading bar.
let _apiInFlight = 0;
function _bumpApiLoader(delta) {
  _apiInFlight = Math.max(0, _apiInFlight + delta);
  let bar = document.getElementById('global-loader');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'global-loader';
    bar.innerHTML = '<div class="gl-fill"></div>';
    document.body.appendChild(bar);
  }
  bar.classList.toggle('active', _apiInFlight > 0);
}

// Endpoints we DON'T want to show the top loader for (background pollers):
const _SILENT_FNS = new Set([
  'api_notifications_mine', 'api_call_logEvent', 'api_company_info'
]);

async function api(fn, ...args) {
  const silent = _SILENT_FNS.has(fn);
  if (!silent) _bumpApiLoader(+1);
  try {
    const res = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn, args: [CRM.token, ...args] })
    });
    const j = await res.json();
    if (!res.ok || j.error) {
      if (j.error && /token|User inactive/i.test(j.error)) logout();
      throw new Error(j.error || 'API error');
    }
    return j.result;
  } finally {
    if (!silent) _bumpApiLoader(-1);
  }
}
async function apiRaw(fn, ...args) {
  const res = await fetch('/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fn, args })
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error || 'API error');
  return j.result;
}

/* ---------------- Boot ---------------- */
(async () => {
  try {
    const r = await fetch('/config.json');
    if (r.ok) CRM.config = Object.assign(CRM.config, await r.json());
  } catch (_) {}
  document.title = CRM.config.company_name || 'Lead CRM';

  if (CRM.token) {
    try {
      CRM.user = await api('api_me');
      renderShell();
      await warmCache();
      // Resolve chat access for the current user — admin can disable chat
      // for specific roles. Stored in CRM.access.can_chat so renderShell's
      // nav rendering and gates check it consistently.
      try {
        const acc = await api('api_chat_myAccess');
        CRM.access = Object.assign(CRM.access || {}, {
          can_chat: !!acc.can_chat, chat_allowed_roles: acc.allowed_roles || []
        });
      } catch (_) {
        CRM.access = Object.assign(CRM.access || {}, { can_chat: true });
      }
      navigateTo(parseHashView() || 'dashboard');
      startFollowupPolling();
      refreshNotifs();
      // Load + render any active announcement banners. Polls every 60s so a
      // freshly-posted admin announcement appears for already-logged-in users
      // without them needing to refresh.
      refreshAnnouncements();
      setInterval(() => refreshAnnouncements().catch(() => {}), 60_000);
      // In-app chat notification popup — polls every 10s while the user is
      // anywhere in the CRM. Always starts (the backend endpoint silently
      // refuses for users with chat disabled). Skips popping when the chat
      // tab is open with that exact room visible.
      startChatNotificationPolling();
      // Register Web Push so the user's phone gets SMS-style banners even
      // when the CRM tab / installed PWA is closed. Runs after a short delay
      // so it doesn't block initial render. Silently skips on browsers that
      // don't support push or where the user declines permission.
      setTimeout(() => registerWebPush().catch(() => {}), 2000);
      // Native push (Capacitor APK only) — talks to Firebase Cloud Messaging.
      // No-ops in regular browsers / installed PWAs (those use Web Push above).
      setTimeout(() => registerCapacitorPush().catch(() => {}), 2500);
      // If a notification tap launched the app cold and we stashed the
      // target URL before the router was ready, apply it now that we're in.
      try {
        const pending = sessionStorage.getItem('pendingPushUrl');
        if (pending) {
          sessionStorage.removeItem('pendingPushUrl');
          setTimeout(() => applyPushUrl(pending), 1000);
        }
      } catch (_) {}
      // Resume any pending call (WebView may have been killed during the call).
      // Runs after warmCache so the lead's status options etc are loaded.
      setTimeout(() => _resumePendingCall('boot'), 1500);
      // First-run onboarding (APK only) — if user has never picked a
      // call-recordings folder, prompt them with a clear modal so they
      // don't have to discover it via the Dialer tab.
      setTimeout(() => firstRunRecordingPrompt().catch(() => {}), 2500);
      // If user is already checked in today (came back to app later in
      // the day), resume the 30-min location-ping loop so the trail
      // continues from where the previous session left off.
      setTimeout(() => _resumeLocationPingsIfCheckedIn().catch(() => {}), 3000);
      // Silent background sweep: pick up any missed recordings.
      setTimeout(() => silentBackgroundSync(), 4000);
    } catch (_) { logout(); }
  } else {
    renderLogin();
  }

  // When the service worker fires a notificationclick, it posts a 'navigate'
  // message back to the page — route to the URL the push payload pointed at.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', ev => {
      const m = ev && ev.data;
      if (m && m.type === 'navigate' && m.url) {
        try { location.assign(m.url); } catch (_) { location.href = m.url; }
      }
    });
  }

  window.addEventListener('hashchange', () => {
    if (!CRM.user) return;
    navigateTo(parseHashView() || 'dashboard');
  });
})();

function parseHashView() {
  const m = String(location.hash).match(/^#\/([a-z_-]+)/i);
  return m ? m[1] : null;
}

async function warmCache() {
  const [statuses, sources, products, users, customFields] = await Promise.all([
    api('api_statuses_list'),
    api('api_sources_list'),
    api('api_products_list'),
    api('api_users_list'),
    api('api_customFields_list').catch(() => [])
  ]);
  CRM.cache = { statuses, sources, products, users, customFields };
}

/* ---------------- utility ---------------- */
const $ = (sel, ctx) => (ctx || document).querySelector(sel);
const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v === false || v == null) {}
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(s, opts) {
  if (!s) return '';
  try {
    const d = new Date(s);
    if (opts === 'short') return d.toLocaleDateString();
    if (opts === 'time') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (opts === 'relative') {
      const diff = Date.now() - d.getTime();
      const abs = Math.abs(diff);
      const min = Math.round(abs / 60000);
      const rel = diff >= 0 ? ago => ago + ' ago' : ago => 'in ' + ago;
      if (min < 1) return 'just now';
      if (min < 60) return rel(min + 'm');
      const hr = Math.round(min / 60);
      if (hr < 24) return rel(hr + 'h');
      return rel(Math.round(hr / 24) + 'd');
    }
    return d.toLocaleString();
  } catch (_) { return String(s); }
}

/**
 * Convert any datetime stored in the DB (ISO UTC, or naive Postgres timestamp)
 * to a "YYYY-MM-DDTHH:mm" string in the user's LOCAL timezone, suitable for
 * a datetime-local input. Without this, a UTC value like 2026-04-25T15:10:00Z
 * shows in the form as 15:10 instead of the local 20:40.
 */
function isoToLocalDtInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 16);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Inverse of isoToLocalDtInput. Converts a "YYYY-MM-DDTHH:mm" datetime-local
 * value (interpreted as the user's local time) into a UTC ISO string the
 * server can store and round-trip safely. JavaScript's Date constructor parses
 * datetime-local strings as local time — toISOString() then emits proper UTC.
 */
function localDtInputToIso(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toISOString();
}
function toast(msg, type = 'ok') {
  const t = h('div', { class: `toast toast-${type}` }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
function confirmDialog(msg) {
  return new Promise(resolve => {
    const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) { modal.remove(); resolve(false); } } },
      h('div', { class: 'modal modal-sm' },
        h('p', {}, msg),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => { modal.remove(); resolve(false); } }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => { modal.remove(); resolve(true); } }, 'OK')
        )
      )
    );
    document.body.appendChild(modal);
  });
}

function logout() {
  localStorage.removeItem('crm_token');
  CRM.token = null; CRM.user = null;
  location.hash = '';
  location.reload();
}

/* ---------------- Login ---------------- */
function renderLogin() {
  const app = $('#app');
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand">
          ${CRM.config.company_logo_url ? `<img src="${esc(CRM.config.company_logo_url)}" class="login-logo" alt="" />` : '<div class="login-logo-dot">🎯</div>'}
          <h1>${esc(CRM.config.company_name || 'Lead CRM')}</h1>
          <p class="muted">Sign in to continue</p>
        </div>
        <form id="login-form">
          <label>Email</label>
          <input type="email" name="email" autocomplete="username" required autofocus />
          <label>Password</label>
          <input type="password" name="password" autocomplete="current-password" required />
          <button type="submit" class="btn primary block">Sign in</button>
          <p id="login-err" class="error"></p>
        </form>
      </div>
    </div>`;
  $('#login-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    $('#login-err').textContent = '';
    try {
      const r = await apiRaw('api_login', f.email.value, f.password.value);
      // 2FA path — server returned a challenge token instead of a session.
      // Swap the form for an OTP entry step. The user's challenge expires
      // in 5 minutes; api_login_otp_verify exchanges it for the real token.
      if (r && r.needs_otp && r.challenge_token) {
        showOtpStep(r.challenge_token, r.user || { email: f.email.value });
        return;
      }
      CRM.token = r.token; CRM.user = r.user;
      localStorage.setItem('crm_token', r.token);
      location.reload();
    } catch (e) { $('#login-err').textContent = e.message; }
  });
}

/**
 * Security modal — change password + manage 2FA (Google Authenticator).
 *
 * 2FA flow:
 *   1. User clicks "Set up 2FA" → server generates a fresh secret (saved
 *      with totp_enabled=0 so the half-set-up state can't lock anyone out).
 *   2. We render a QR code (qrcode.js loaded from cdnjs) plus the raw
 *      base32 for manual entry.
 *   3. User scans, types one code, clicks Verify → server flips the
 *      totp_enabled flag to 1.
 *   4. From the next login onwards, the OTP step in the login form fires.
 *
 * Disable requires the current password AND a current OTP — defends
 * against both a hijacked session token and a stolen/known password.
 */
async function openSecurityModal() {
  let me;
  try { me = await api('api_me'); }
  catch (e) { return toast(e.message, 'err'); }

  const status = h('div', { class: 'sec-status' });
  const renderStatus = () => {
    status.innerHTML = '';
    const enabled = !!me.totp_enabled;
    status.appendChild(h('div', {
      style: { padding: '10px 12px', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
               background: enabled ? 'var(--ok-soft)' : 'var(--warn-soft)',
               color: enabled ? 'var(--ok)' : 'var(--warn)', fontWeight: 500 } },
      h('span', {}, enabled ? '✓ Two-factor authentication is enabled' : '⚠ Two-factor authentication is not enabled'),
      enabled
        ? h('button', { class: 'btn sm', onclick: () => disable2FA() }, 'Disable')
        : h('button', { class: 'btn sm primary', onclick: () => setup2FA() }, 'Set up 2FA')
    ));
  };

  const setup2FA = async () => {
    let r;
    try { r = await api('api_2fa_setup_start'); }
    catch (e) { return toast(e.message, 'err'); }

    const qrHolder = h('div', { id: 'sec-qr', style: { width: '180px', height: '180px', background: '#fff', border: '1px solid var(--border)', padding: '8px', borderRadius: '6px' } });
    const otpInput = h('input', { name: 'otp', maxlength: '6', inputmode: 'numeric', placeholder: '000000',
      style: { fontSize: '1.2rem', letterSpacing: '.3em', textAlign: 'center', fontFamily: 'monospace' } });

    const setupModal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '🔒 Set up two-factor authentication'),
        h('button', { class: 'btn icon', onclick: () => setupModal.remove() }, '✕')
      ),
      h('ol', { style: { paddingLeft: '1.2rem', fontSize: '.88rem', lineHeight: '1.55' } },
        h('li', {}, 'Install Google Authenticator (or Microsoft Authenticator / Authy / 1Password) on your phone.'),
        h('li', {}, 'Open the app and tap +, choose ', h('b', {}, 'Scan QR code'), '.'),
        h('li', {}, 'Scan this code:')
      ),
      h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', justifyContent: 'center', margin: '10px 0', flexWrap: 'wrap' } },
        qrHolder,
        h('div', { style: { fontSize: '.8rem' } },
          h('div', { class: 'muted' }, 'Or type this secret manually:'),
          h('code', { style: { display: 'inline-block', padding: '4px 8px', marginTop: '4px', background: 'var(--bg-alt)', borderRadius: '4px', fontSize: '.85rem', wordBreak: 'break-all' } }, r.secret),
          h('div', { class: 'muted', style: { marginTop: '6px' } }, 'Issuer: ' + (r.issuer || 'CRM')),
          h('div', { class: 'muted' }, 'Account: ' + (r.account || me.email))
        )
      ),
      h('label', {}, '4. Enter the 6-digit code shown in your authenticator:'),
      otpInput,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => setupModal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            await api('api_2fa_setup_verify', otpInput.value.trim());
            toast('2FA enabled — you\'ll need your authenticator app to sign in next time');
            me.totp_enabled = true;
            setupModal.remove();
            renderStatus();
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Verify and enable')
      )
    ));
    document.body.appendChild(setupModal);

    // Render QR code. Library is ~16KB from cdnjs, loaded once and cached.
    const drawQr = () => {
      if (!window.QRCode) return setTimeout(drawQr, 200);
      qrHolder.innerHTML = '';
      new window.QRCode(qrHolder, { text: r.otpauth_url, width: 168, height: 168, correctLevel: window.QRCode.CorrectLevel.M });
    };
    if (!window.QRCode) {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = drawQr;
      document.head.appendChild(s);
    } else { drawQr(); }
  };

  const disable2FA = async () => {
    const pwInput = h('input', { type: 'password', autocomplete: 'current-password' });
    const otpInput = h('input', { name: 'otp', maxlength: '6', inputmode: 'numeric', placeholder: '000000',
      style: { letterSpacing: '.2em', textAlign: 'center', fontFamily: 'monospace' } });
    const disableModal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal modal-sm' },
      h('div', { class: 'modal-head' },
        h('h3', {}, 'Disable 2FA'),
        h('button', { class: 'btn icon', onclick: () => disableModal.remove() }, '✕')
      ),
      h('p', { class: 'muted', style: { fontSize: '.85rem' } }, 'Confirm your password and a current 6-digit code to disable two-factor authentication.'),
      h('label', {}, 'Password'),
      pwInput,
      h('label', { style: { marginTop: '8px' } }, 'Current 6-digit code'),
      otpInput,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => disableModal.remove() }, 'Cancel'),
        h('button', { class: 'btn danger', onclick: async () => {
          try {
            await api('api_2fa_disable', pwInput.value, otpInput.value.trim());
            toast('2FA disabled');
            me.totp_enabled = false;
            disableModal.remove();
            renderStatus();
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Disable')
      )
    ));
    document.body.appendChild(disableModal);
  };

  // Change password section
  const cpOld = h('input', { type: 'password', autocomplete: 'current-password' });
  const cpNew = h('input', { type: 'password', autocomplete: 'new-password', minlength: '6' });

  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('div', { class: 'modal-head' },
      h('h3', {}, '🔒 Security'),
      h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
    ),

    h('h4', { style: { margin: '4px 0 8px' } }, 'Two-factor authentication'),
    status,
    h('p', { class: 'muted', style: { fontSize: '.78rem', marginTop: '6px' } },
      'Adds a 6-digit code from your phone on top of your password. Strongly recommended for admins and managers.'),

    h('hr', { style: { margin: '18px 0', border: '0', borderTop: '1px solid var(--border-light)' } }),

    h('h4', { style: { margin: '4px 0 8px' } }, 'Change password'),
    h('label', {}, 'Current password'), cpOld,
    h('label', { style: { marginTop: '8px' } }, 'New password'), cpNew,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Close'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!cpOld.value || !cpNew.value) return toast('Both fields required', 'err');
        if (cpNew.value.length < 6) return toast('New password must be at least 6 characters', 'err');
        try {
          await api('api_changePassword', cpOld.value, cpNew.value);
          toast('Password changed');
          cpOld.value = ''; cpNew.value = '';
        } catch (e) { toast(e.message, 'err'); }
      } }, 'Update password')
    )
  ));
  document.body.appendChild(modal);
  renderStatus();
}

function showOtpStep(challengeToken, who) {
  const card = document.querySelector('.login-card');
  if (!card) return;
  card.innerHTML = `
    <div class="login-brand">
      ${CRM.config && CRM.config.company_logo_url ? `<img src="${esc(CRM.config.company_logo_url)}" class="login-logo" alt="" />` : '<div class="login-logo-dot">🔒</div>'}
      <h1>Two-step verification</h1>
      <p class="muted">Enter the 6-digit code from your authenticator app for ${esc(who.email || '')}.</p>
    </div>
    <form id="login-otp-form">
      <label>6-digit code</label>
      <input type="text" name="otp" inputmode="numeric" autocomplete="one-time-code"
             maxlength="6" pattern="[0-9]{6}" required autofocus
             style="font-size:1.4rem;letter-spacing:.4em;text-align:center;font-family:var(--font-mono,monospace);" />
      <button type="submit" class="btn primary block">Verify and sign in</button>
      <p id="login-err" class="error"></p>
      <button type="button" class="btn ghost block" id="login-otp-back" style="margin-top:.5rem;">← Use a different account</button>
    </form>`;
  document.getElementById('login-otp-back').addEventListener('click', () => location.reload());
  document.getElementById('login-otp-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const otp = ev.target.otp.value.trim();
    document.getElementById('login-err').textContent = '';
    try {
      const r = await apiRaw('api_login_otp_verify', challengeToken, otp);
      CRM.token = r.token; CRM.user = r.user;
      localStorage.setItem('crm_token', r.token);
      location.reload();
    } catch (e) { document.getElementById('login-err').textContent = e.message; }
  });
}

/* ---------------- Shell ---------------- */
// Sidebar is grouped into collapsible sections (à la Zoho/HubSpot) to keep
// the menu compact. `pinned: true` items render at the very top with no
// group header. Every other item lives under a NAV_GROUP entry.
// NAV is kept as a flat array (computed from NAV_GROUPS) so existing code
// that does `NAV.forEach`, `NAV.find`, `mobilePrimary.includes(item.id)`
// keeps working unchanged.
const NAV_GROUPS = [
  { label: '', items: [
    { id: 'dashboard',  label: 'Dashboard',    icon: '📊', pinned: true }
  ] },
  { label: 'Sales', icon: '💼', items: [
    { id: 'leads',      label: 'Leads',          icon: '🎯' },
    { id: 'pipeline',   label: 'Pipeline',       icon: '📈' },
    { id: 'kanban',     label: 'Kanban',         icon: '🗂️' },
    { id: 'followups',  label: 'Follow-ups',     icon: '🔔' },
    { id: 'calendar',   label: 'Calendar',       icon: '📅' },
    { id: 'targets',    label: 'Monthly Target', icon: '🎯' },
    { id: 'newleads',   label: 'New leads',      icon: '✨', countKey: 'new_today' },
    { id: 'overdue',    label: 'Overdue',        icon: '⚠️', countKey: 'overdue' },
    { id: 'duetoday',   label: 'Due today',      icon: '📅', countKey: 'due_today' },
    { id: 'upcoming',   label: 'Upcoming',       icon: '⏰', countKey: 'upcoming' }
  ] },
  { label: 'Calls', icon: '📞', items: [
    { id: 'dialer',       label: 'Dialer',        icon: '📞' },
    { id: 'callinsights', label: 'Call insights', icon: '🎙' },
    { id: 'callratings',  label: 'Call ratings',  icon: '⭐', roles: ['admin', 'manager', 'team_leader'] },
    { id: 'aiusage',      label: 'AI usage',      icon: '🤖', roles: ['admin', 'manager'] }
  ] },
  { label: 'Catalog', icon: '📦', items: [
    { id: 'inventory',  label: 'Inventory', icon: '📦' },
    { id: 'projects',   label: 'Projects',  icon: '🚚' }
  ] },
  { label: 'Reports', icon: '📉', items: [
    { id: 'reports',       label: 'Reports',         icon: '📉', roles: ['admin', 'manager', 'team_leader'] },
    { id: 'reportbuilder', label: 'Report builder',  icon: '🧪', roles: ['admin', 'manager', 'team_leader'] },
    { id: 'tatreport',     label: 'TAT report',      icon: '⏱️', roles: ['admin', 'manager', 'team_leader'] }
  ] },
  { label: 'Workspace', icon: '💬', items: [
    { id: 'whatsbot',  label: 'WhatsBot',  icon: '💬' },
    { id: 'knowledge', label: 'Knowledge', icon: '📚' },
    { id: 'teamchat',  label: 'Team chat', icon: '👥', countKey: 'chat_unread' }
  ] },
  { label: 'HR & Me', icon: '🕒', items: [
    { id: 'tasks',      label: 'Tasks',      icon: '✅' },
    { id: 'attendance', label: 'Attendance', icon: '🕒' },
    { id: 'leaves',     label: 'Leaves',     icon: '🏖️' },
    { id: 'salary',     label: 'Salary',     icon: '💰' },
    { id: 'bank',       label: 'Bank',       icon: '🏦' }
  ] },
  { label: 'Admin', icon: '⚙️', items: [
    { id: 'users', label: 'Users',    icon: '👥', roles: ['admin', 'manager'] },
    { id: 'admin', label: 'Settings', icon: '⚙️', roles: ['admin'] }
  ] }
];
// Flatten for backwards-compat with anywhere that iterates NAV.
const NAV = NAV_GROUPS.flatMap(g => g.items);

function renderShell() {
  const initials = (CRM.user.name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  $('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          ${CRM.config.company_logo_url ? `<img src="${esc(CRM.config.company_logo_url)}" class="sidebar-logo" alt="" />` : '<span class="brand-dot">🎯</span>'}
          <span class="brand-name">${esc(CRM.config.company_name)}</span>
        </div>
        <nav id="nav"></nav>
        <div class="sidebar-footer">
          <div class="me">
            <span class="avatar">${esc(initials)}</span>
            <div class="me-meta">
              <div class="name">${esc(CRM.user.name)}</div>
              <div class="role">${esc(CRM.user.role)}</div>
            </div>
          </div>
          <button class="btn ghost block" id="btn-security" style="margin-bottom:.35rem;">🔒 Security</button>
          <button class="btn ghost block" id="btn-logout">Logout</button>
        </div>
      </aside>
      <main class="main">
        <div id="announce-bar"></div>
        <header class="topbar">
          <button class="btn icon topbar-mobile-menu" id="btn-more" title="Menu">☰</button>
          <h2 id="page-title">Dashboard</h2>
          <div class="topbar-right">
            <a class="btn ghost topbar-chip" href="#/newleads" title="New leads"><span>✨</span><span class="topbar-chip-label">New</span><span class="nav-count" data-count-key="new_today" hidden>0</span></a>
            <a class="btn ghost topbar-chip" href="#/overdue"  title="Overdue follow-ups"><span>⚠️</span><span class="topbar-chip-label">Overdue</span><span class="nav-count" data-count-key="overdue" hidden>0</span></a>
            <a class="btn ghost topbar-chip" href="#/duetoday" title="Follow-ups due today"><span>📅</span><span class="topbar-chip-label">Due today</span><span class="nav-count" data-count-key="due_today" hidden>0</span></a>
            <a class="btn ghost topbar-chip" href="#/upcoming" title="Upcoming follow-ups"><span>⏰</span><span class="topbar-chip-label">Upcoming</span><span class="nav-count" data-count-key="upcoming" hidden>0</span></a>
            <button class="btn ghost" id="btn-getapp" title="Install / Download the app"><span>📱</span><span class="topbar-getapp-text">Get app</span></button>
            <button class="btn ghost" id="btn-notif" title="Notifications">🔔<span class="badge" id="notif-count" hidden>0</span></button>
          </div>
        </header>
        <section id="view"></section>
      </main>
      <nav class="bottom-nav" id="bottom-nav"></nav>
    </div>`;
  const nav = $('#nav');
  const mobileNav = $('#bottom-nav');
  // Mobile bottom bar: 4 main + More
  const mobilePrimary = ['dashboard', 'leads', 'dialer', 'followups'];
  // Items the admin has hidden via Settings → Menu visibility (CSV in
  // hidden_nav_ids served by /config.json). The three quick-action
  // shortcuts (newleads / overdue / upcoming) are hidden by default
  // since they now live as chips in the topbar; admin can re-enable
  // them in Settings if they prefer the sidebar links.
  const hiddenNavIds = String(CRM.config.hidden_nav_ids || 'newleads,overdue,duetoday,upcoming,dialer')
    .split(',').map(s => s.trim()).filter(Boolean);

  // Helper: make one anchor for a NAV item. Returns null if user can't see it.
  const _navAnchor = (item) => {
    if (item.roles && !item.roles.includes(CRM.user.role)) return null;
    if (hiddenNavIds.includes(item.id)) return null;
    if (item.id === 'teamchat' && CRM.access && CRM.access.can_chat === false) return null;
    const countBadge = item.countKey
      ? h('span', { class: 'nav-count', 'data-count-key': item.countKey, hidden: 'hidden' }, '0')
      : null;
    return h('a', { href: '#/' + item.id, 'data-view': item.id },
      h('span', { class: 'nav-icon' }, item.icon),
      h('span', {}, item.label),
      countBadge);
  };

  // Persist which groups the user has expanded (per-device). Default is
  // collapsed — users only see top-level section headers until they click
  // one open, mirroring the Zoho sidebar pattern.
  const expandedKey = 'crm_nav_expanded_v1';
  const expanded = new Set((localStorage.getItem(expandedKey) || '').split(',').filter(Boolean));
  const _saveExpanded = () => localStorage.setItem(expandedKey, [...expanded].join(','));

  NAV_GROUPS.forEach(group => {
    // Build the visible item anchors first so we can skip an empty group.
    const anchors = group.items.map(_navAnchor).filter(Boolean);
    if (!anchors.length) return;

    // Pinned group (no header) — render flat, no collapse chevron.
    if (!group.label) {
      anchors.forEach(a => nav.appendChild(a));
      return;
    }

    // Auto-collapse the group whose active item lives — that one starts
    // open so the user sees where they are. Otherwise default = collapsed
    // unless the user has previously toggled it open.
    const groupHasActive = group.items.some(i => i.id === (location.hash.replace('#/', '') || 'dashboard'));
    const isCollapsed = !(expanded.has(group.label) || groupHasActive);
    const groupEl = h('div', { class: 'nav-group' + (isCollapsed ? ' collapsed' : '') });
    const headBtn = h('button', {
      class: 'nav-group-head',
      type: 'button',
      onclick: () => {
        groupEl.classList.toggle('collapsed');
        if (groupEl.classList.contains('collapsed')) expanded.delete(group.label);
        else expanded.add(group.label);
        _saveExpanded();
      }
    },
      h('span', { class: 'nav-group-icon' }, group.icon || ''),
      h('span', { class: 'nav-group-label' }, group.label),
      h('span', { class: 'nav-group-chev' }, '▾')
    );
    const itemsWrap = h('div', { class: 'nav-group-items' });
    anchors.forEach(a => itemsWrap.appendChild(a));
    groupEl.appendChild(headBtn);
    groupEl.appendChild(itemsWrap);
    nav.appendChild(groupEl);
  });

  // Mobile bottom bar — flat lookup against the original NAV list.
  NAV.forEach(item => {
    if (item.roles && !item.roles.includes(CRM.user.role)) return;
    if (hiddenNavIds.includes(item.id)) return;
    if (item.id === 'teamchat' && CRM.access && CRM.access.can_chat === false) return;
    if (mobilePrimary.includes(item.id)) {
      const ma = h('a', { href: '#/' + item.id, 'data-view': item.id },
        h('span', { class: 'bn-ico' }, item.icon),
        h('span', {}, item.label));
      mobileNav.appendChild(ma);
    }
  });
  // "More" button opens the full menu as a bottom sheet
  mobileNav.appendChild(h('a', { href: '#', onclick: ev => { ev.preventDefault(); showMobileMore(); } },
    h('span', { class: 'bn-ico' }, '⋯'), h('span', {}, 'More')));

  $('#btn-logout').onclick = logout;
  const _btnSec = $('#btn-security'); if (_btnSec) _btnSec.onclick = openSecurityModal;
  $('#btn-notif').onclick = showNotifs;
  $('#btn-more').onclick = showMobileMore;
  const _ga = $('#btn-getapp'); if (_ga) _ga.onclick = showGetApp;
}

/**
 * Get App modal — shows the user how to install the CRM as a PWA on their
 * phone (Chrome → Add to Home Screen) and offers a direct download link
 * for the Android APK if one is hosted in /public/.
 */
function showGetApp() {
  const apkHref = '/LeadCRM.apk';
  const ua = navigator.userAgent || '';
  const isAndroid = /android/i.test(ua);
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const url = location.origin + '/';
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '📱 Get the CRM on your phone'),
        h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
      ),
      h('div', { class: 'modal-body' },
        h('p', { class: 'muted', style: { marginTop: 0 } },
          'Install the CRM on your phone so you get push notifications even when the browser is closed.'),
        h('div', { class: 'cards', style: { gap: '.75rem' } },
          h('div', { class: 'card' },
            h('h4', { style: { margin: '0 0 .5rem' } }, '📱 Install as PWA (recommended)'),
            h('ol', { style: { paddingLeft: '1.2rem', margin: 0 } },
              h('li', {}, 'Open this site in Chrome on your phone: ', h('code', {}, url)),
              h('li', {}, isIOS
                ? 'Tap the Share button (square + arrow) → "Add to Home Screen".'
                : 'Tap the ⋮ menu in Chrome → "Install app" or "Add to Home screen".'),
              h('li', {}, 'Open the new icon and allow notifications when prompted.')
            )
          ),
          isAndroid || !isIOS ? h('div', { class: 'card' },
            h('h4', { style: { margin: '0 0 .5rem' } }, '⬇️ Direct APK (Android)'),
            h('p', { class: 'muted', style: { marginTop: 0 } },
              'For Android only. You may have to allow "Install from unknown sources".'),
            h('a', { class: 'btn primary', href: apkHref, download: '' }, 'Download LeadCRM.apk')
          ) : null
        )
      )
    )
  );
  document.body.appendChild(m);
}

function showMobileMore() {
  const sheet = h('div', { class: 'modal-backdrop bottom-nav-more-modal', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) sheet.remove(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, esc(CRM.config.company_name || 'Menu')),
        h('button', { class: 'btn icon', onclick: () => sheet.remove() }, '✕')
      ),
      h('div', { class: 'me', style: { padding: '.5rem 0' } },
        h('span', { class: 'avatar' }, (CRM.user.name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase()),
        h('div', { class: 'me-meta' },
          h('div', { class: 'name' }, CRM.user.name),
          h('div', { class: 'role muted' }, CRM.user.role + ' · ' + CRM.user.email)
        )
      ),
      h('div', { class: 'mobile-menu-grid' },
        ...NAV.filter(item => {
          if (item.roles && !item.roles.includes(CRM.user.role)) return false;
          if (item.id === 'teamchat' && CRM.access && CRM.access.can_chat === false) return false;
          return true;
        }).map(item =>
          h('a', { href: '#/' + item.id, class: 'menu-tile', onclick: () => sheet.remove() },
            h('span', { class: 'menu-tile-icon' }, item.icon),
            h('span', {}, item.label))
        )
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn block', onclick: () => { sheet.remove(); logout(); } }, 'Logout')
      )
    )
  );
  document.body.appendChild(sheet);
}

function navigateTo(id) {
  // Stop any running view-scoped timers (e.g. the WhatsBot Chat polling) so
  // they don't keep hammering the API after the user has navigated away to
  // a different section. Each view that creates timers is responsible for
  // parking them on `window._<viewname>Timers`.
  if (id !== 'whatsbot' && window._wbChatTimers) {
    clearInterval(window._wbChatTimers.threadList);
    clearInterval(window._wbChatTimers.activeThread);
    window._wbChatTimers = null;
  }
  if (id !== 'teamchat' && window._tcTimers) {
    clearInterval(window._tcTimers.list);
    clearInterval(window._tcTimers.thread);
    window._tcTimers = null;
  }

  // Catch the "user just made a call from CRM and came back to the app"
  // case — _resumePendingCall is idempotent and bails when not relevant,
  // so safe to call on every navigation. Belt-and-braces in addition to
  // the visibilitychange / focus / pageshow listeners.
  if (typeof _resumePendingCall === 'function') {
    setTimeout(() => _resumePendingCall('navigate').catch?.(() => {}), 100);
  }

  // Routes that exist as VIEWS but aren't in the sidebar NAV (e.g. /dial,
  // /newleads, /overdue) should still render — don't fall back to NAV[0]
  // when a valid VIEW exists. Falling back was redirecting the call-from-
  // mobile dial route to dashboard on cold-start.
  let item = NAV.find(n => n.id === id);
  if (!item && VIEWS[id]) {
    item = { id, label: id.charAt(0).toUpperCase() + id.slice(1) };
  }
  if (!item) item = NAV[0];
  $$('.sidebar nav a, #bottom-nav a').forEach(a => a.classList.toggle('active', a.dataset.view === item.id));
  $('#page-title').textContent = item.label;
  const view = $('#view');
  view.innerHTML = '<div class="loading">Loading…</div>';
  if (parseHashView() !== item.id) location.hash = '#/' + item.id;
  const fn = VIEWS[item.id];
  Promise.resolve(fn ? fn(view) : null).catch(e => {
    view.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  });
}

const VIEWS = {};

/* ---------------- Dashboard ---------------- */
VIEWS.dashboard = async (view) => {
  await ensureChartJs();
  // Team follow-ups card — admin/manager/team_leader see how each rep is
  // doing on overdue + due-today + TAT violations. Sales/employee don't
  // (it's just their own numbers, already shown in the KPI cards above).
  const showTeam = ['admin', 'manager', 'team_leader'].includes(CRM.user.role);
  const [summary, due, teamFu, teamTat] = await Promise.all([
    api('api_reports_summary', {}),
    api('api_notifications_mine'),
    showTeam ? api('api_reports_followupsByUser').catch(() => [])      : Promise.resolve([]),
    showTeam ? api('api_reports_tatViolationsByUser').catch(() => [])  : Promise.resolve([])
  ]);
  view.innerHTML = '';

  // 5 KPI cards — added "New today" so users can see today's fresh leads
  // at a glance from the dashboard without having to filter the leads list.
  view.append(
    h('div', { class: 'cards' },
      card('Total Leads',  summary.totals.total,      'accent', '🎯', '#/leads'),
      card('New today',    due.counts.new_today || 0, 'accent', '✨', '#/leads?filter=new_today'),
      card('Won',          summary.totals.won,        'ok',     '🏆', '#/leads?filter=won'),
      card('Due today',    due.counts.due_today,      'warn',   '📅', '#/followups?tab=due'),
      card('Overdue',      due.counts.overdue,        'err',    '⚠️', '#/followups?tab=overdue')
    )
  );

  // Two-column: upcoming follow-ups + pie chart
  const grid = h('div', { class: 'dash-grid' });
  view.appendChild(grid);

  // Follow-ups card — three tabs in one box: Upcoming / Overdue / Due today.
  // Renders the same row markup for each list so the user has a consistent
  // glance at upcoming work no matter which tab they're on.
  const fuCard = h('div', { class: 'card fu-tabs-card' });
  const tabs = [
    { key: 'upcoming',  label: 'Upcoming',  rows: due.upcoming || [] },
    { key: 'overdue',   label: 'Overdue',   rows: due.overdue  || [] },
    { key: 'due_today', label: 'Due today', rows: due.due_today || [] }
  ];
  const tabBar = h('div', { class: 'fu-tabbar' });
  const tabBody = h('div', { class: 'fu-tabbody' });
  function renderFuTab(activeKey) {
    [...tabBar.children].forEach(btn => btn.classList.toggle('active', btn.dataset.key === activeKey));
    const tab = tabs.find(t => t.key === activeKey);
    tabBody.innerHTML = '';
    if (!tab.rows.length) {
      tabBody.appendChild(h('p', { class: 'muted', style: { padding: '.5rem' } },
        activeKey === 'overdue' ? 'No overdue follow-ups. 🎉' :
        activeKey === 'due_today' ? 'Nothing due today.' :
        'No upcoming follow-ups.'));
      return;
    }
    tabBody.appendChild(h('ul', { class: 'fu-dash-list' },
      ...tab.rows.slice(0, 8).map(f => h('li', {},
        h('div', { class: 'fu-name', onclick: () => openLeadModal(f.lead_id) }, f.lead_name || '—'),
        h('div', { class: 'fu-phone muted' }, f.lead_phone || ''),
        h('div', { class: 'fu-due ' + (new Date(f.due_at) < new Date() ? 'overdue' : '') }, fmtDate(f.due_at, 'relative'))
      ))
    ));
    if (tab.rows.length > 8) {
      tabBody.appendChild(h('div', { class: 'muted', style: { fontSize: '.8rem', textAlign: 'center', padding: '.4rem' } },
        '+ ' + (tab.rows.length - 8) + ' more — see Follow-ups'));
    }
  }
  tabs.forEach(t => tabBar.appendChild(
    h('button', { class: 'fu-tab' + (t.key === 'upcoming' ? ' active' : ''), 'data-key': t.key,
      onclick: () => renderFuTab(t.key) },
      t.label, t.rows.length ? h('span', { class: 'fu-tab-count' }, t.rows.length) : null
    )
  ));
  fuCard.appendChild(h('div', { class: 'fu-tabs-head' },
    h('h3', { style: { margin: 0 } }, '⏰ Follow-ups'),
    h('a', { href: '#/followups', class: 'btn sm ghost' }, 'See all →')
  ));
  fuCard.appendChild(tabBar);
  fuCard.appendChild(tabBody);
  renderFuTab('upcoming');
  grid.appendChild(fuCard);

  // Pie chart — leads by status
  const pieCard = h('div', { class: 'card' },
    h('h3', {}, '🎯 Leads by status'),
    h('div', { class: 'chart-wrap' }, h('canvas', { id: 'dash-pie' }))
  );
  grid.appendChild(pieCard);

  // Team follow-ups by caller — managers see who's drowning in overdue.
  // Hidden for sales/employee since their own numbers are already in KPI tiles.
  if (showTeam) {
    const teamRows = teamFu || [];
    const teamCard = h('div', { class: 'card card-wide' },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.5rem' } },
        h('h3', { style: { margin: 0 } }, '👥 Follow-ups by caller'),
        h('a', { href: '#/followups', class: 'btn sm ghost' }, 'See all →')
      )
    );
    if (!teamRows.length) {
      teamCard.appendChild(h('p', { class: 'muted' }, 'No team data available.'));
    } else {
      teamCard.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Caller'), h('th', {}, 'Role'),
          h('th', { style: { textAlign: 'right' } }, '⚠️ Overdue'),
          h('th', { style: { textAlign: 'right' } }, '📅 Due today'),
          h('th', { style: { textAlign: 'right' } }, '⏰ Upcoming'),
          h('th', { style: { textAlign: 'right' } }, 'Total open')
        )),
        h('tbody', {}, ...teamRows.map(r => h('tr', {},
          h('td', {}, r.name || '—'),
          h('td', { class: 'muted' }, r.role || ''),
          h('td', { class: r.overdue > 0 ? 'cell-err' : 'muted', style: { textAlign: 'right', fontWeight: r.overdue > 0 ? 700 : 400 } }, r.overdue),
          h('td', { class: r.due_today > 0 ? 'cell-warn' : 'muted', style: { textAlign: 'right', fontWeight: r.due_today > 0 ? 700 : 400 } }, r.due_today),
          h('td', { class: 'muted', style: { textAlign: 'right' } }, r.upcoming),
          h('td', { style: { textAlign: 'right', fontWeight: 600 } }, r.total_open)
        )))
      )));
    }
    grid.appendChild(teamCard);

    // Team TAT violations by caller — same intent: who's accumulating
    // escalations? Hidden if there are no open violations org-wide.
    const tatRows = teamTat || [];
    if (tatRows.length) {
      const tatCard = h('div', { class: 'card card-wide' },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.5rem' } },
          h('h3', { style: { margin: 0 } }, '🚨 TAT violations by caller'),
          h('a', { href: '#/tatreport', class: 'btn sm ghost' }, 'See full TAT report →')
        ),
        h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'Caller'), h('th', {}, 'Role'),
            h('th', { style: { textAlign: 'right' }, title: 'L3 — escalated to admin' }, '🚨 L3'),
            h('th', { style: { textAlign: 'right' }, title: 'L2 — escalated to manager' }, '⚠️ L2'),
            h('th', { style: { textAlign: 'right' }, title: 'L1 — employee reminder' }, '⏱️ L1'),
            h('th', { style: { textAlign: 'right' } }, 'Total open')
          )),
          h('tbody', {}, ...tatRows.map(r => h('tr', {},
            h('td', {}, r.name || '—'),
            h('td', { class: 'muted' }, r.role || ''),
            h('td', { class: r.l3 > 0 ? 'cell-err' : 'muted', style: { textAlign: 'right', fontWeight: r.l3 > 0 ? 700 : 400 } }, r.l3),
            h('td', { class: r.l2 > 0 ? 'cell-warn' : 'muted', style: { textAlign: 'right', fontWeight: r.l2 > 0 ? 700 : 400 } }, r.l2),
            h('td', { class: 'muted', style: { textAlign: 'right' } }, r.l1),
            h('td', { style: { textAlign: 'right', fontWeight: 600 } }, r.total)
          )))
        ))
      );
      grid.appendChild(tatCard);
    }
  }

  // By source bar chart
  const srcCard = h('div', { class: 'card card-wide' },
    h('h3', {}, 'Leads by source'),
    h('div', { class: 'chart-wrap' }, h('canvas', { id: 'dash-src' }))
  );
  grid.appendChild(srcCard);

  setTimeout(() => {
    const statusData = (summary.by_status || []).filter(x => x.c > 0);
    // User asked for the dashboard "Leads by status" to be a bar chart with
    // visible numbers (not a pie). Bar chart with status colors and datalabels.
    makeChart('dash-pie', 'bar', statusData.map(x => x.status), statusData.map(x => x.c), statusData.map(x => x.color));
    const srcData = summary.by_source || [];
    makeChart('dash-src', 'bar', srcData.map(x => x.source), srcData.map(x => x.c));
  }, 50);

  function card(label, val, klass, icon, href) {
    const inner = h('div', { class: `card stat ${klass}` + (href ? ' clickable' : '') },
      h('div', { class: 'stat-icon' }, icon || ''),
      h('div', { class: 'stat-body' },
        h('div', { class: 'stat-label' }, label),
        h('div', { class: 'stat-value' }, val ?? 0)
      )
    );
    if (href) inner.onclick = () => { location.hash = href; };
    return inner;
  }
};

/* ---------------- Leads ---------------- */
const LEAD_COLUMNS = [
  { key: 'name',        label: 'Name',          default: true },
  { key: 'phone',       label: 'Phone',         default: true },
  { key: 'email',       label: 'Email',         default: false },
  { key: 'whatsapp',    label: 'WhatsApp',      default: false },
  { key: 'source',      label: 'Source',        default: true },
  { key: 'product',     label: 'Product',       default: false },
  { key: 'status',      label: 'Status',        default: true },
  { key: 'assigned',    label: 'Assigned',      default: true },
  { key: 'tags',        label: 'Tags',          default: false },
  { key: 'followup',    label: 'Follow-up',     default: true },
  { key: 'last_change', label: 'Last change',   default: true },
  { key: 'remark',      label: 'Recent remark', default: true },
  { key: 'city',        label: 'City',          default: false },
  { key: 'created',     label: 'Created',       default: true }
];

VIEWS.leads = async (view) => {
  if (!CRM.cache.statuses) await warmCache();
  const { statuses, sources, users } = CRM.cache;

  view.innerHTML = '';

  if (CRM.prefs.showHeader !== false) {
    const header = h('div', { class: 'leads-header' },
      h('div', { class: 'leads-status-chips', id: 'status-chips' }),
      h('div', { class: 'header-actions' },
        h('button', { class: 'btn sm ghost', title: 'Hide header', onclick: () => toggleHeader(false) }, '− Hide')
      )
    );
    view.appendChild(header);
  } else {
    view.appendChild(h('div', { class: 'header-hidden-toggle' },
      h('button', { class: 'btn sm ghost', onclick: () => toggleHeader(true) }, '▾ Show header')
    ));
  }

  // Auto-apply filter on dropdown change + debounced search input. Without
  // this, mobile users had to find the small 🔎 button after every change,
  // which made filters feel "broken" in the Android APK.
  //
  // We attach BOTH change AND input event listeners — Android WebView is
  // flaky about which one fires first on native dropdown selection, and
  // some users reported filters not applying despite the JS being correct.
  // addEventListener is more robust than .onchange (nothing can clobber it).
  const applyFilters = () => { CRM._leadsPage = 1; loadLeads({ page: 1 }); };
  const wireFilter = (sel) => {
    if (!sel) return sel;
    sel.addEventListener('change', applyFilters);
    sel.addEventListener('input', applyFilters); // Android WebView fallback
    return sel;
  };
  let _searchTimer = null;
  const debouncedSearch = () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(applyFilters, 350);
  };
  const searchInput = h('input', { id: 'f-q', placeholder: 'Search name / phone / email…', class: 'flex', value: CRM.prefs.filters.q || '' });
  searchInput.addEventListener('input', debouncedSearch);
  searchInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') applyFilters(); });
  const toolbar = h('div', { class: 'toolbar' },
    searchInput,
    wireFilter(selectOpts('f-status', [{ id: '', name: 'Any status' }, ...statuses], CRM.prefs.filters.status_id)),
    wireFilter(selectOpts('f-source', [{ id: '', name: 'Any source' }, ...sources.map(s => ({ id: s.name, name: s.name }))], CRM.prefs.filters.source)),
    wireFilter(selectOpts('f-assigned', [{ id: '', name: 'Any assignee' }, ...users], CRM.prefs.filters.assigned_to)),
    wireFilter(selectOpts('f-followup', [{ id: '', name: 'All follow-ups' }, { id: 'today', name: 'Due today' }, { id: 'overdue', name: 'Overdue' }], CRM.prefs.filters.followup)),
    wireFilter(selectOpts('f-qualified', [
      { id: '',  name: 'Any qualified' },
      { id: '1', name: '⭐ Qualified only' },
      { id: '0', name: 'Not qualified' }
    ], CRM.prefs.filters.qualified)),
    wireFilter(selectOpts('f-duplicate', [
      { id: '', name: 'All leads' },
      { id: 'only', name: '⚠️ Duplicates only' },
      { id: 'unique', name: 'No duplicates' }
    ], CRM.prefs.filters.duplicate)),
    // Sort: newest/oldest by created_at, or by last-updated. Default
    // 'created_desc' matches the previous hard-coded behaviour so saved
    // filters from before this option keep working unchanged.
    wireFilter(selectOpts('f-sort', [
      { id: 'created_desc', name: '🆕 Created — newest first' },
      { id: 'created_asc',  name: '⏳ Created — oldest first' },
      { id: 'updated_desc', name: '✏️ Updated — newest first' },
      { id: 'updated_asc',  name: '⏳ Updated — oldest first' }
    ], CRM.prefs.filters.sort || 'created_desc')),
    h('button', { class: 'btn', onclick: () => { CRM._leadsPage = 1; loadLeads({ page: 1 }); } }, '🔎'),
    h('button', { class: 'btn ghost', onclick: openSavedFiltersMenu, title: 'Saved filter presets' }, '📌'),
    h('button', { class: 'btn ghost', onclick: clearFilters, title: 'Reset filters' }, '✕'),
    h('button', { class: 'btn ghost', id: 'btn-refresh-leads', onclick: refreshLeads, title: 'Refresh leads list' }, '🔄'),
    h('button', { class: 'btn ghost', onclick: openColumnChooser, title: 'Columns' }, '☰'),
    h('button', { class: 'btn ghost', onclick: openBulkUpload, title: 'Upload CSV' }, '⬆️'),
    h('button', { class: 'btn ghost', onclick: exportCSV, title: 'Export CSV' }, '⬇️'),
    (CRM.user && (CRM.user.role === 'admin' || CRM.user.role === 'manager'))
      ? h('button', { class: 'btn ghost danger', onclick: deleteAllDuplicates, title: 'Delete every lead marked DUP' }, '🗑️ Dedupe')
      : null,
    (CRM.user && (CRM.user.role === 'admin' || CRM.user.role === 'manager'))
      ? h('button', { class: 'btn ghost', title: 'Move every lead with <10-digit phone to Junk', onclick: async () => {
          if (!await confirmDialog('Scan all leads and move ones with phone < 10 digits to Junk? This is a one-shot cleanup; you can re-run later.')) return;
          try { const r = await api('api_leads_cleanupJunk'); toast(`Moved ${r.moved} leads to Junk · ${r.skipped} skipped`); loadLeads(); }
          catch (e) { toast(e.message, 'err'); }
        } }, '🧹 Junk cleanup')
      : null,
    h('button', { class: 'btn primary', onclick: () => openLeadModal() }, '+ New Lead')
  );
  view.appendChild(toolbar);

  view.appendChild(h('div', { class: 'bulk-bar', id: 'bulk-bar', hidden: true },
    h('span', { id: 'bulk-count', class: 'bulk-count' }, '0 selected'),
    h('button', { class: 'btn sm', onclick: bulkAssignPrompt }, '👤 Assign'),
    h('button', { class: 'btn sm', onclick: bulkStatusPrompt }, '🏷️ Status'),
    h('button', { class: 'btn sm', onclick: bulkAddTagPrompt }, '🏁 Add tag'),
    h('button', { class: 'btn sm', onclick: bulkWhatsAppPrompt }, '💬 WhatsApp'),
    h('button', { class: 'btn sm danger', onclick: bulkDelete }, '🗑️ Delete'),
    h('button', { class: 'btn sm ghost', onclick: () => clearSelection() }, 'Clear')
  ));

  view.appendChild(h('div', { class: 'table-wrap' }, h('table', { id: 'leads-table', class: 'leads-table' })));
  // Mobile card container (only visible on ≤ 780px via CSS)
  view.appendChild(h('div', { class: 'leads-mobile', id: 'leads-mobile' }));
  // Pagination footer placeholder (loadLeads populates it)
  view.appendChild(h('div', { id: 'leads-pagination', class: 'pagination-bar' }));
  // Mobile FAB
  view.appendChild(h('button', { class: 'fab', onclick: () => openLeadModal(), title: 'New lead' }, '+'));

  CRM._leadsPage = 1;
  await loadLeads({ page: 1 });
};

function toggleHeader(show) {
  CRM.prefs.showHeader = show;
  localStorage.setItem('crm_show_header', show ? '1' : '0');
  navigateTo('leads');
}
function clearFilters() {
  CRM.prefs.filters = {};
  localStorage.setItem('crm_filters', '{}');
  navigateTo('leads');
}

/**
 * Saved filter presets — modal to save the current filter combo under a
 * name and one-click re-apply or delete saved presets. Admins can flag
 * a preset as shared (visible to everyone in the org).
 */
async function openSavedFiltersMenu() {
  const isAdmin = CRM.user && CRM.user.role === 'admin';
  let saved;
  try { saved = await api('api_filters_list', 'leads'); }
  catch (e) { return toast(e.message, 'err'); }

  const list = h('div', { class: 'sf-list', style: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '320px', overflowY: 'auto' } });
  const renderList = (items) => {
    list.innerHTML = '';
    if (!items.length) {
      list.appendChild(h('div', { class: 'muted', style: { padding: '8px', textAlign: 'center', fontSize: '.85rem' } }, 'No saved filters yet.'));
      return;
    }
    items.forEach(f => {
      const row = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', padding: '6px 8px', borderRadius: '4px', background: 'var(--bg-alt)' } },
        h('button', {
          type: 'button', class: 'btn ghost',
          style: { flex: '1', textAlign: 'left', padding: '4px 6px' },
          onclick: () => {
            const fObj = (typeof f.filter_json === 'string') ? JSON.parse(f.filter_json || '{}') : (f.filter_json || {});
            CRM.prefs.filters = fObj;
            localStorage.setItem('crm_filters', JSON.stringify(fObj));
            modal.remove();
            navigateTo('leads');
          }
        },
          h('span', {}, f.name),
          Number(f.is_shared) === 1 ? h('span', { class: 'muted', style: { fontSize: '.7rem', marginLeft: '6px' } }, '🌐 shared') : null
        ),
        (Number(f.user_id) === Number(CRM.user.id) || isAdmin)
          ? h('button', { type: 'button', class: 'btn icon', title: 'Delete', onclick: async () => {
              try { await api('api_filters_delete', f.id); toast('Filter deleted'); items.splice(items.indexOf(f), 1); renderList(items); }
              catch (e) { toast(e.message, 'err'); }
            } }, '🗑️')
          : null
      );
      list.appendChild(row);
    });
  };

  const nameInput = h('input', { placeholder: 'Filter name (e.g. "Mumbai · hot · negotiation")' });
  const sharedBox = h('input', { type: 'checkbox' });
  const shareRow = isAdmin
    ? h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '.82rem', marginTop: '4px' } },
        sharedBox,
        ' Share with everyone in the org'
      )
    : null;

  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal modal-sm' },
    h('div', { class: 'modal-head' },
      h('h3', {}, '📌 Saved filters'),
      h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
    ),
    h('p', { class: 'muted', style: { fontSize: '.82rem', marginTop: 0 } },
      'Save the current filter combination under a name, or click a saved preset to apply it.'),
    list,
    h('hr', { style: { margin: '12px 0', border: 0, borderTop: '1px solid var(--border-light)' } }),
    h('label', { style: { fontSize: '.85rem' } }, 'Save current filters as:'),
    nameInput,
    shareRow,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Close'),
      h('button', { class: 'btn primary', onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) return toast('Give the filter a name', 'err');
        try {
          await api('api_filters_save', {
            name,
            view: 'leads',
            filter: CRM.prefs.filters || {},
            is_shared: (isAdmin && sharedBox.checked) ? 1 : 0
          });
          toast('Filter saved');
          saved = await api('api_filters_list', 'leads');
          renderList(saved);
          nameInput.value = '';
          if (isAdmin) sharedBox.checked = false;
        } catch (e) { toast(e.message, 'err'); }
      } }, 'Save')
    )
  ));
  document.body.appendChild(modal);
  renderList(saved);
}

async function loadLeads(opts) {
  opts = opts || {};
  const pageSize = Number(localStorage.getItem('crm_page_size') || 25);
  const page = Number(opts.page || CRM._leadsPage || 1);
  CRM._leadsPage = page;
  const filters = {
    q:           $('#f-q')?.value || undefined,
    status_id:   $('#f-status')?.value || undefined,
    source:      $('#f-source')?.value || undefined,
    assigned_to: $('#f-assigned')?.value || undefined,
    followup:    $('#f-followup')?.value || undefined,
    qualified:   $('#f-qualified')?.value || undefined,
    duplicate:   $('#f-duplicate')?.value || undefined,
    sort:        $('#f-sort')?.value || undefined,
    page,
    page_size:   pageSize
  };
  // Save user-visible filters only (not page/page_size — those are session state)
  const savedFilters = Object.assign({}, filters);
  delete savedFilters.page; delete savedFilters.page_size;
  CRM.prefs.filters = savedFilters;
  localStorage.setItem('crm_filters', JSON.stringify(savedFilters));

  try {
    const res = await api('api_leads_list', filters);
    CRM.cache.lastLeads = res.leads;
    CRM.cache.lastStatusCounts = res.status_count;
    CRM.cache.lastTotal = res.total || (res.leads || []).length;
    renderLeadsTable(res.leads);
    renderStatusChips(res.status_count);
    renderLeadsPagination({
      total: res.total || res.leads.length,
      page: res.page || 1,
      pageSize: res.page_size || pageSize
    });
  } catch (e) {
    $('#leads-table').innerHTML = `<tbody><tr><td colspan="99" class="error-box">${esc(e.message)}</td></tr></tbody>`;
  }
}

/** Pagination footer with page-size selector + Prev/Next + page numbers. */
function renderLeadsPagination({ total, page, pageSize }) {
  let bar = $('#leads-pagination');
  if (!bar) {
    bar = h('div', { id: 'leads-pagination', class: 'pagination-bar' });
    const tableWrap = $('#leads-table')?.closest('.table-wrap');
    if (tableWrap && tableWrap.parentNode) {
      tableWrap.parentNode.insertBefore(bar, tableWrap.nextSibling);
    } else {
      $('#view').appendChild(bar);
    }
  }
  bar.innerHTML = '';
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, total);

  // Page-size selector
  const sizeSel = h('select', { id: 'page-size-sel', class: 'page-size-sel',
    onchange: ev => {
      localStorage.setItem('crm_page_size', String(Number(ev.target.value) || 25));
      CRM._leadsPage = 1;
      loadLeads({ page: 1 });
    }
  });
  [10, 20, 25, 50, 100, 200, 500].forEach(n => {
    sizeSel.appendChild(h('option', { value: n, selected: n === pageSize ? 'selected' : null }, `${n} per page`));
  });
  bar.appendChild(h('div', { class: 'pagination-left' }, sizeSel));

  // Range info
  bar.appendChild(h('div', { class: 'pagination-info muted' },
    total === 0 ? 'No leads' : `${from}–${to} of ${total}`
  ));

  // Page navigation
  const nav = h('div', { class: 'pagination-nav' });
  const goto = (p) => { CRM._leadsPage = p; loadLeads({ page: p }); };
  nav.appendChild(h('button', {
    class: 'btn sm', disabled: safePage === 1 ? 'disabled' : null,
    onclick: () => goto(1)
  }, '« First'));
  nav.appendChild(h('button', {
    class: 'btn sm', disabled: safePage === 1 ? 'disabled' : null,
    onclick: () => goto(safePage - 1)
  }, '‹ Prev'));

  // Numeric page buttons (windowed: show up to 5 around current)
  const start = Math.max(1, safePage - 2);
  const end = Math.min(pages, start + 4);
  for (let p = start; p <= end; p++) {
    nav.appendChild(h('button', {
      class: 'btn sm' + (p === safePage ? ' primary' : ''),
      onclick: () => goto(p)
    }, String(p)));
  }
  nav.appendChild(h('button', {
    class: 'btn sm', disabled: safePage >= pages ? 'disabled' : null,
    onclick: () => goto(safePage + 1)
  }, 'Next ›'));
  nav.appendChild(h('button', {
    class: 'btn sm', disabled: safePage >= pages ? 'disabled' : null,
    onclick: () => goto(pages)
  }, 'Last »'));
  bar.appendChild(nav);
}

function renderStatusChips(statusCount) {
  const el = $('#status-chips');
  if (!el) return;
  const { statuses } = CRM.cache;
  el.innerHTML = '';
  // Active status comes from the filter dropdown — chip for the matching
  // status gets a highlighted "active" style so the user can see what's
  // applied at a glance.
  const activeStatusId = String($('#f-status')?.value || CRM.prefs.filters.status_id || '');
  // "All" chip — clicking it clears the status filter
  const allActive = !activeStatusId;
  el.appendChild(h('span', {
    class: 'status-chip clickable' + (allActive ? ' active' : ''),
    onclick: () => applyStatusChipFilter('')
  },
    h('span', { class: 'chip-label' }, 'All'),
    h('span', { class: 'chip-count' }, Object.values(statusCount || {}).reduce((a, b) => a + Number(b || 0), 0))
  ));
  statuses.forEach(s => {
    const c = statusCount?.[String(s.id)] || statusCount?.[s.id] || 0;
    const isActive = String(s.id) === activeStatusId;
    el.appendChild(h('span', {
      class: 'status-chip clickable' + (isActive ? ' active' : ''),
      onclick: () => applyStatusChipFilter(s.id),
      style: isActive ? { background: s.color, color: '#fff', borderColor: s.color } : null
    },
      h('span', { class: 'chip-dot', style: { background: s.color } }),
      h('span', { class: 'chip-label' }, s.name),
      h('span', { class: 'chip-count' }, c)
    ));
  });
}

/** Click handler used by both the chips and other parts of the UI. */
function applyStatusChipFilter(statusId) {
  const sel = document.getElementById('f-status');
  if (sel) sel.value = String(statusId || '');
  CRM.prefs.filters = Object.assign({}, CRM.prefs.filters, { status_id: statusId || '' });
  try { localStorage.setItem('crm_filters', JSON.stringify(CRM.prefs.filters)); } catch (_) {}
  CRM._leadsPage = 1;
  loadLeads({ page: 1 });
}

function getActiveColumns() {
  const saved = CRM.prefs.columns && CRM.prefs.columns.length ? CRM.prefs.columns : null;
  return saved || LEAD_COLUMNS.filter(c => c.default).map(c => c.key);
}

function renderLeadsTable(rows) {
  const tbl = $('#leads-table');
  if (!tbl) return;
  const { statuses, customFields } = CRM.cache;
  const activeCols = getActiveColumns();
  const extraCols = (customFields || []).filter(f => f.show_in_list);

  const thead = h('thead', {},
    h('tr', {},
      h('th', { class: 'th-check' }, h('input', { type: 'checkbox', id: 'sel-all', onclick: ev => selectAll(ev.target.checked) })),
      ...activeCols.map(key => h('th', {}, (LEAD_COLUMNS.find(c => c.key === key) || {}).label || key)),
      ...extraCols.map(f => h('th', {}, f.label)),
      h('th', {})
    )
  );
  const tbody = h('tbody', {});
  if (!rows.length) {
    tbody.appendChild(h('tr', {}, h('td', { colspan: activeCols.length + extraCols.length + 2, class: 'empty' }, 'No leads match your filters.')));
  } else {
    rows.forEach(l => {
      const rowCls = [
        l.is_duplicate ? 'row-duplicate' : '',
        l.tat_violation ? 'row-tat-violation' : ''
      ].filter(Boolean).join(' ');
      tbody.appendChild(h('tr', { class: rowCls, title: l.tat_violation ? tatViolationTitle(l) : null },
        h('td', { class: 'td-check' }, h('input', { type: 'checkbox', class: 'row-check', 'data-id': l.id, onclick: onRowCheck })),
        ...activeCols.map(col => renderCell(col, l, statuses)),
        ...extraCols.map(f => h('td', {}, (l.extra && l.extra[f.key]) || '')),
        h('td', { class: 'td-actions' },
          h('button', { class: 'btn sm ghost', onclick: () => openLeadModal(l.id) }, '✎')
        )
      ));
    });
  }
  tbl.innerHTML = '';
  tbl.append(thead, tbody);

  $$('select[data-lead-status]', tbl).forEach(sel =>
    sel.addEventListener('change', async () => {
      try {
        await api('api_leads_update', Number(sel.dataset.leadStatus), { status_id: Number(sel.value) });
        toast('Status updated');
        const opt = CRM.cache.statuses.find(s => Number(s.id) === Number(sel.value));
        if (opt) sel.style.background = opt.color;
        loadLeads();
      } catch (e) { toast(e.message, 'err'); }
    })
  );

  // Mobile card view
  renderLeadsMobile(rows);
}

function renderLeadsMobile(rows) {
  const m = $('#leads-mobile');
  if (!m) return;
  m.innerHTML = '';
  if (!rows.length) {
    m.appendChild(h('div', { class: 'empty' }, 'No leads match your filters.'));
    return;
  }
  const { statuses } = CRM.cache;
  rows.forEach(l => {
    const digits = String(l.phone || '').replace(/\D/g, '');
    const statusColor = l.status_color || '#6b7280';
    const due = l.next_followup_at ? new Date(l.next_followup_at) : null;
    const overdue = due && due < new Date();
    const cardCls = 'lead-card'
      + (l.is_duplicate ? ' row-duplicate' : '')
      + (l.tat_violation ? ' row-tat-violation' : '');
    const card = h('div', { class: cardCls, title: l.tat_violation ? tatViolationTitle(l) : null },
      h('div', { class: 'lc-head' },
        h('a', { href: '#', class: 'lc-name', onclick: ev => { ev.preventDefault(); openLeadModal(l.id); } }, l.name || '—'),
        h('span', { class: 'lc-status', style: { background: statusColor } }, l.status_name || '')
      ),
      h('div', { class: 'lc-meta' },
        l.phone ? h('span', {}, '📞 ', l.phone) : null,
        l.source ? h('span', {}, '• ', l.source) : null,
        l.assigned_name ? h('span', {}, '👤 ', l.assigned_name) : null
      ),
      l.tat_violation ? h('div', { class: 'tat-pill', title: tatViolationTitle(l) }, '⚠ TAT BREACH — ', tatOverLabel(l)) : null,
      l.is_duplicate ? h('div', { class: 'dup-pill', onclick: () => openDuplicateHistory(l.id) }, '⚠ DUP — see past') : null,
      due ? h('div', { class: 'lc-fu' + (overdue ? ' overdue' : '') }, '⏰ ' + fmtDate(l.next_followup_at, 'relative')) : null,
      l.recent_remark ? h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.3rem' } }, '💬 ' + (l.recent_remark || '').slice(0, 80)) : null,
      h('div', { class: 'lc-actions' },
        digits ? h('button', { class: 'btn sm btn-call', onclick: () => callLead(l) }, '📞 Call') : null,
        digits ? h('button', { class: 'btn sm wa-cloud-btn', onclick: () => openInitiateChatModal(l) }, '🟢 WA') : null,
        digits ? h('button', {
          class: 'btn sm', onclick: () => openPersonalWaPicker(l)
        }, '💬 My WA') : null,
        digits ? h('button', { class: 'btn sm', onclick: () => sendCalendlyLink(l) }, '📅 Meet') : null,
        h('button', { class: 'btn sm', onclick: () => openRemarkInline(l.id) }, '📝 Note'),
        h('button', { class: 'btn sm ghost', onclick: () => openLeadModal(l.id) }, '✎ Edit')
      )
    );
    m.appendChild(card);
  });
}

/** Click-to-call.
 *
 *  RELIABLE FLOW: open the after-call modal IMMEDIATELY when the user taps,
 *  before firing the tel: link. The modal sits in the background while the
 *  user is on the call. When they hang up and return to the app, the modal
 *  is right there waiting — no dependency on Android telling us "call ended".
 *
 *  Why we do it this way: Android 12+ deprecated PhoneStateListener,
 *  READ_CALL_LOG / READ_PHONE_STATE are sensitive permissions, and OEM
 *  battery managers (Xiaomi, OnePlus, Samsung, etc.) aggressively kill
 *  background services. Trying to detect "call ended" reliably across all
 *  phones is a maintenance nightmare. Opening the modal at dial-time works
 *  on every phone, on every Android version, with zero permissions.
 *
 *  We still stash the call context to localStorage so _resumePendingCall
 *  can re-open the modal if the WebView is killed mid-call. */
function callLead(lead) {
  const raw = String(lead.phone || '');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return toast('No phone number', 'warn');
  const startedAt = Date.now();
  CRM.pendingCall = { lead, startedAt, dialedPhone: digits };

  // Stash everything we need to reopen the modal even if the WebView dies.
  try {
    localStorage.setItem('crm_pending_call', JSON.stringify({
      leadId: lead.id || null,
      leadName: lead.name || '',
      leadPhone: lead.phone || '',
      startedAt,
      dialedPhone: digits
    }));
  } catch (e) { console.warn(e); }

  if (window.LeadCRMNative && typeof LeadCRMNative.registerOutgoingCall === 'function') {
    try {
      LeadCRMNative.registerOutgoingCall(
        digits, lead.id ? String(lead.id) : '', startedAt
      );
    } catch (e) { console.warn('[leadcrm] registerOutgoingCall:', e); }
  }

  // Log a server-side call_events row so the recording sync gate has a
  // reference point. Best-effort — doesn't block the dial.
  try {
    api('api_call_logEvent', {
      phone: lead.phone || '',
      direction: 'out',
      event: 'dial_requested',
      duration_s: 0
    }).catch(() => {});
  } catch (_) {}

  // Fire the tel: link FIRST so the dialer opens immediately (any user
  // gesture context is still active here)
  const hasPlus = raw.trim().startsWith('+');
  const telTarget = (hasPlus ? '+' : '') + digits;
  const a = document.createElement('a');
  a.href = 'tel:' + telTarget;
  a.click();

  // Then open the after-call modal. It sits in the background while the
  // user is on the call. When they return to the app, it's already there.
  // setTimeout 0 so this runs after the tel: navigation has been queued.
  setTimeout(() => {
    if (!document.querySelector('.after-call-modal')) {
      openAfterCallModal(lead);
    }
  }, 0);
}

/**
 * Called on every app launch + every visibility change. If we find a recent
 * (within 10 minutes) pending call in localStorage that hasn't been resolved,
 * open the modal + start the recording sync. This is the bulletproof path
 * that works even when Android kills the WebView during the call.
 */
async function _resumePendingCall(reason) {
  // Skip if a modal is already open (don't double-open)
  if (document.querySelector('.after-call-modal')) return;

  let raw;
  try { raw = localStorage.getItem('crm_pending_call'); } catch (e) { return; }
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    localStorage.removeItem('crm_pending_call');
    return;
  }
  if (!data || !data.startedAt) {
    localStorage.removeItem('crm_pending_call');
    return;
  }
  const elapsed = Date.now() - data.startedAt;
  // Skip immediate triggers (<2s = accidental tap)
  if (elapsed < 2000) return;
  // Skip stale entries (>10 min old = abandoned)
  if (elapsed > 10 * 60 * 1000) {
    localStorage.removeItem('crm_pending_call');
    return;
  }

  console.log('[leadcrm] resuming pending call:', reason, 'elapsed=' + Math.round(elapsed/1000) + 's');

  // Clear the stash so we don't re-trigger
  localStorage.removeItem('crm_pending_call');
  CRM.pendingCall = null;

  // Get a full lead record (so the modal has status_id, etc.)
  let lead = null;
  if (data.leadId) {
    try {
      const r = await api('api_leads_get', data.leadId);
      lead = (r && (r.lead || r));
    } catch (e) {
      lead = { id: data.leadId, name: data.leadName, phone: data.leadPhone };
    }
  } else if (data.leadName || data.leadPhone) {
    lead = { name: data.leadName, phone: data.leadPhone };
  }
  if (!lead) return;

  // Slight delay so the rest of the UI has settled
  setTimeout(() => {
    openAfterCallModalWithRecording(lead, {
      lead,
      startedAt: data.startedAt,
      dialedPhone: data.dialedPhone || ''
    });
  }, 600);
}

// Fire after-call modal whenever the user returns to the app after tapping
// Call. Three triggers cover every case — WebView still alive (in-memory
// pendingCall) AND WebView killed and recreated (localStorage stash).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _resumePendingCall('visibilitychange');
});
window.addEventListener('focus', () => _resumePendingCall('focus'));
window.addEventListener('pageshow', () => _resumePendingCall('pageshow'));

async function openAfterCallModal(lead) {
  const { statuses } = CRM.cache;
  const modal = h('div', { class: 'modal-backdrop after-call-modal' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '📞 Call ' + (lead.name || 'lead')),
        h('button', { class: 'btn icon', onclick: () => modal.remove(), title: 'Close — you can re-open from the lead' }, '✕')
      ),
      h('p', { class: 'muted', style: { background: '#fef3c7', color: '#92400e', padding: '.6rem .8rem', borderRadius: '8px', borderLeft: '3px solid #f59e0b' } },
        '☎️ Dialer is opening now. After your call, return here and fill in the status + remark below — this window will be waiting for you.'),
      h('label', {}, 'Status'),
      h('select', { id: 'ac-status' },
        ...statuses.map(s => h('option', { value: s.id, selected: Number(s.id) === Number(lead.status_id) ? 'selected' : null }, s.name))
      ),
      h('label', {}, 'Remark — what was discussed, next step?'),
      h('textarea', { id: 'ac-remark', rows: 4, placeholder: 'e.g. Customer needs more details on payment plan, sending brochure tomorrow' }),
      h('label', {}, 'Next follow-up (optional)'),
      h('input', { type: 'datetime-local', id: 'ac-followup' }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Skip'),
        h('button', { class: 'btn primary', onclick: async () => {
          const statusId = Number($('#ac-status').value);
          const remark = $('#ac-remark').value.trim();
          const fu = $('#ac-followup').value;
          const patch = {};
          if (statusId && statusId !== Number(lead.status_id)) patch.status_id = statusId;
          if (fu) patch.next_followup_at = localDtInputToIso(fu);
          try {
            if (Object.keys(patch).length) await api('api_leads_update', lead.id, patch);
            if (remark) await api('api_leads_addRemark', lead.id, { remark });
            toast('Updated');
            modal.remove();
            // Clear the pending-call stash so we don't re-open this modal
            // on the next visibilitychange / nav.
            try { localStorage.removeItem('crm_pending_call'); } catch (_) {}
            CRM.pendingCall = null;
            if (typeof loadLeads === 'function') loadLeads();
          } catch (e) { toast(e.message, 'err'); }
        } }, '✓ Save update')
      )
    )
  );
  document.body.appendChild(modal);
  // Don't auto-focus the textarea — opening the soft keyboard while the
  // dialer is launching can fight for focus and look janky. User taps
  // when they return.
}

/**
 * Format the elapsed-over-threshold time as a short human label. Used in
 * the TAT-breach pill and tooltips. Always falls back to the full
 * minutes-as-number if the lead doesn't carry a tat_minutes_over value
 * (e.g. legacy server response that pre-dates the tat_violation flag).
 */
function tatOverLabel(l) {
  const m = Number(l && l.tat_minutes_over);
  if (!Number.isFinite(m) || m <= 0) return 'overdue';
  if (m < 60)            return m + 'm over';
  if (m < 60 * 24)       return Math.round(m / 60) + 'h over';
  return Math.round(m / (60 * 24)) + 'd over';
}
function tatViolationTitle(l) {
  const limit = Number(l && l.tat_threshold_minutes) || 0;
  const status = (l && l.status_name) || 'this stage';
  const over = tatOverLabel(l);
  const limitLabel = limit < 60
    ? limit + ' min'
    : (limit % 60 === 0 ? (limit / 60) + ' h' : (limit + ' min'));
  return `TAT breach — sat in "${status}" for ${over} (limit ${limitLabel})`;
}

function renderCell(col, l, statuses) {
  switch (col) {
    case 'name': {
      return h('td', { class: 'cell-name' },
        h('a', { href: '#', onclick: ev => { ev.preventDefault(); openLeadModal(l.id); } }, l.name || '—'),
        l.is_duplicate ? h('span', { class: 'dup-pill', title: 'Duplicate — click to see past leads', onclick: ev => { ev.stopPropagation(); ev.preventDefault(); openDuplicateHistory(l.id); } }, 'DUP') : null,
        l.tat_violation ? h('span', { class: 'tat-pill', title: tatViolationTitle(l) }, '⚠ TAT ', tatOverLabel(l)) : null
      );
    }
    case 'phone': {
      const digits = String(l.phone || '').replace(/\D/g, '');
      return h('td', { class: 'cell-phone' },
        l.phone || '',
        digits ? h('button', { class: 'btn icon', title: 'Call from this device', onclick: ev => { ev.stopPropagation(); callLead(l); } }, '📞') : null,
        // Push the call to YOUR phone — when you have the APK installed and
        // logged in, FCM wakes the phone and opens its native dialer with
        // the number pre-filled. Useful when you're on desktop CRM but want
        // to actually dial from your handset (recordings + carrier minutes).
        digits ? h('button', {
          class: 'btn icon', title: 'Send to my mobile phone — opens dialer there',
          onclick: ev => { ev.stopPropagation(); callViaMobile(l); }
        }, '📱') : null,
        l.phone ? h('button', { class: 'btn icon', title: 'Copy', onclick: ev => { ev.stopPropagation(); navigator.clipboard.writeText(l.phone); toast('Copied'); } }, '📋') : null,
        // Green WhatsApp icon — opens the Initiate Chat modal which lets
        // the user pick an approved template, fill variables, preview and
        // send. Replaces the old wa.me deep link.
        digits ? h('button', {
          class: 'btn icon wa-cloud-btn', title: 'Send WhatsApp template (from business number via Cloud API)',
          onclick: ev => { ev.stopPropagation(); openInitiateChatModal(l); }
        }, '🟢') : null,
        // Personal WhatsApp — opens a template picker. Picking a template
        // launches WhatsApp with the message pre-filled (rep just hits
        // Send). Truly silent sending isn't possible from a personal
        // number — that's the 🟢 Cloud-API button's job.
        digits ? h('button', {
          class: 'btn icon', title: 'Send WhatsApp from my number — pick a template',
          onclick: ev => { ev.stopPropagation(); openPersonalWaPicker(l); }
        }, '💬') : null,
        // Calendly meeting link — opens WhatsApp with the rep's
        // booking page pre-filled. Only shows if the rep has set
        // a Calendly URL on their profile.
        digits ? h('button', {
          class: 'btn icon', title: 'Send Calendly meeting link via WhatsApp',
          onclick: ev => { ev.stopPropagation(); sendCalendlyLink(l); }
        }, '📅') : null
      );
    }
    case 'email':    return h('td', {}, l.email || '');
    case 'whatsapp': return h('td', {}, l.whatsapp || '');
    case 'source':   return h('td', {}, l.source || '');
    case 'product':  return h('td', {}, l.product_name || l.product || '');
    case 'status': {
      const sel = h('select', {
        class: 'status-pill',
        'data-lead-status': l.id,
        style: { background: l.status_color || '#6b7280' },
        onclick: ev => ev.stopPropagation()
      });
      statuses.forEach(s => sel.appendChild(h('option', {
        value: s.id, selected: Number(s.id) === Number(l.status_id) ? 'selected' : null
      }, s.name)));
      return h('td', {}, sel);
    }
    case 'assigned': return h('td', {}, l.assigned_name || '—');
    case 'tags': {
      const tags = String(l.tags || '').split(',').map(s => s.trim()).filter(Boolean);
      return h('td', {}, ...tags.map(t => h('span', { class: 'tag' }, t)));
    }
    case 'followup': {
      const due = l.next_followup_at ? new Date(l.next_followup_at) : null;
      const overdue = due && due < new Date();
      return h('td', { class: overdue ? 'overdue' : '' }, due ? fmtDate(l.next_followup_at, 'relative') : '');
    }
    case 'last_change': return h('td', { class: 'muted' }, l.last_status_change_at ? fmtDate(l.last_status_change_at, 'relative') : '');
    case 'remark': return h('td', { class: 'cell-remark' },
      h('span', { class: 'remark-text', title: l.recent_remark || '' }, (l.recent_remark || '').slice(0, 60)),
      h('button', { class: 'btn icon', title: 'Add remark', onclick: ev => { ev.stopPropagation(); openRemarkInline(l.id); } }, '💬+')
    );
    case 'city':    return h('td', {}, l.city || '');
    case 'created': return h('td', { class: 'muted' }, fmtDate(l.created_at, 'short'));
    default:        return h('td', {}, '');
  }
}

/* --- selection & bulk --- */
function onRowCheck() {
  const n = $$('.row-check:checked').length;
  const bar = $('#bulk-bar');
  if (!bar) return;
  bar.hidden = n === 0;
  $('#bulk-count').textContent = `${n} selected`;
}
function selectAll(on) {
  $$('.row-check').forEach(c => { c.checked = on; });
  onRowCheck();
}
function clearSelection() {
  const sa = $('#sel-all'); if (sa) sa.checked = false;
  selectAll(false);
}
function selectedIds() {
  return $$('.row-check:checked').map(c => Number(c.dataset.id));
}

async function bulkAssignPrompt() {
  const ids = selectedIds(); if (!ids.length) return;
  const users = CRM.cache.users || [];
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('h3', {}, `Assign ${ids.length} leads`),
    h('label', {}, 'Pick user'),
    h('select', { id: 'bulk-asgn' }, ...users.map(u => h('option', { value: u.id }, `${u.name} — ${u.role}`))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        try { await api('api_leads_bulkUpdate', ids, { assigned_to: Number($('#bulk-asgn').value) }); toast('Assigned'); modal.remove(); clearSelection(); loadLeads(); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Assign')
    )
  ));
  document.body.appendChild(modal);
}
async function bulkStatusPrompt() {
  const ids = selectedIds(); if (!ids.length) return;
  const statuses = CRM.cache.statuses;
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('h3', {}, `Change status of ${ids.length} leads`),
    h('label', {}, 'New status'),
    h('select', { id: 'bulk-st' }, ...statuses.map(s => h('option', { value: s.id }, s.name))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        try { await api('api_leads_bulkUpdate', ids, { status_id: Number($('#bulk-st').value) }); toast('Updated'); modal.remove(); clearSelection(); loadLeads(); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Update')
    )
  ));
  document.body.appendChild(modal);
}
/**
 * Bulk WhatsApp send — fire an approved template to every selected lead.
 *
 * Reuses the existing campaign infra (api_wb_campaigns_create + send_now)
 * so messages queue, retry on failure, log to whatsapp_messages, and show
 * up in the per-lead chat thread automatically.
 *
 * Variables support per-lead merge tokens via @{name}, @{firstname},
 * @{phone}, @{email}, @{source} — same renderer the rest of WhatsBot uses.
 */
async function bulkWhatsAppPrompt() {
  const ids = selectedIds(); if (!ids.length) return;
  const templates = await api('api_wb_templates_list').catch(() => []);
  if (!templates.length) {
    return toast('No approved WhatsApp templates yet — sync from Meta in WhatsBot tab', 'err');
  }

  const tplSel = h('select', { id: 'bw-tpl' },
    ...templates.map(t => h('option', { value: t.name + '|' + (t.language || 'en_US') }, `${t.name} · ${t.language || 'en_US'}`))
  );
  const varsBox = h('div', { id: 'bw-vars', style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' } });
  const previewBox = h('div', { class: 'muted', id: 'bw-preview',
    style: { background: 'var(--bg-alt)', padding: '8px 10px', borderRadius: '6px', fontSize: '.82rem', whiteSpace: 'pre-wrap', marginTop: '8px', minHeight: '40px' } });

  const renderVars = () => {
    const sel = tplSel.value || '';
    const [name, lang] = sel.split('|');
    const tpl = templates.find(t => t.name === name && (t.language || 'en_US') === lang);
    const bodyText = String(tpl?.body_text || '');
    const params = (tpl?.body_params || tpl?.params || []);
    const count = Array.isArray(params) ? params.length : (Number(tpl?.body_params_count) || (bodyText.match(/\{\{\d+\}\}/g) || []).length);
    varsBox.innerHTML = '';
    if (!count) {
      varsBox.appendChild(h('div', { class: 'muted', style: { fontSize: '.78rem' } }, 'This template has no variables.'));
    } else {
      for (let i = 0; i < count; i++) {
        const inp = h('input', { class: 'bw-var', placeholder: 'e.g. @{firstname} or "20%"', 'data-idx': String(i) });
        const row = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('span', { class: 'muted', style: { minWidth: '70px', fontSize: '.78rem' } }, '{{' + (i + 1) + '}}'),
          inp,
          h('button', { type: 'button', class: 'btn sm ghost', title: 'Insert lead first name', onclick: () => { inp.value = '@{firstname}'; updatePreview(); } }, '@name')
        );
        inp.addEventListener('input', updatePreview);
        varsBox.appendChild(row);
      }
    }
    updatePreview();
  };

  const updatePreview = () => {
    const sel = tplSel.value || '';
    const [name, lang] = sel.split('|');
    const tpl = templates.find(t => t.name === name && (t.language || 'en_US') === lang);
    let body = String(tpl?.body_text || '');
    const inputs = Array.from(varsBox.querySelectorAll('.bw-var'));
    inputs.forEach((inp, i) => {
      const v = inp.value || ('{{' + (i + 1) + '}}');
      body = body.replace(new RegExp('\\{\\{' + (i + 1) + '\\}\\}', 'g'), v);
    });
    previewBox.textContent = body || '(empty template)';
  };

  tplSel.addEventListener('change', renderVars);

  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('div', { class: 'modal-head' },
      h('h3', {}, `💬 Send WhatsApp to ${ids.length} lead${ids.length === 1 ? '' : 's'}`),
      h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
    ),
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '.82rem' } },
      'Pick an approved template and fill its variables. Use @{firstname}, @{name}, @{phone}, @{email}, @{source} for per-lead substitution. The send queues through the campaign worker — failures are retried automatically.'),
    h('label', {}, 'Template'),
    tplSel,
    h('label', { style: { marginTop: '10px' } }, 'Variables'),
    varsBox,
    h('label', { style: { marginTop: '10px' } }, 'Preview (first lead)'),
    previewBox,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const sel = tplSel.value || '';
        const [name, lang] = sel.split('|');
        const inputs = Array.from(varsBox.querySelectorAll('.bw-var'));
        const variables = inputs.map(inp => ({ value: inp.value || '' }));
        try {
          const r = await api('api_wb_campaigns_create', {
            name: 'Bulk send · ' + new Date().toLocaleString(),
            template_name: name,
            template_language: lang,
            variables_json: JSON.stringify(variables),
            filter: { lead_ids: ids },
            send_now: 1
          });
          if (r && r.id) {
            await api('api_wb_campaigns_send_now', r.id);
          }
          toast(`Queued WhatsApp send to ${ids.length} leads`);
          modal.remove();
          clearSelection();
        } catch (e) { toast(e.message, 'err'); }
      } }, `Send to ${ids.length}`)
    )
  ));
  document.body.appendChild(modal);
  renderVars();
}

async function bulkAddTagPrompt() {
  const ids = selectedIds(); if (!ids.length) return;
  const tag = prompt('Tag to add to ' + ids.length + ' leads:');
  if (!tag) return;
  const leads = (CRM.cache.lastLeads || []).filter(l => ids.includes(Number(l.id)));
  for (const l of leads) {
    const existing = String(l.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!existing.includes(tag)) existing.push(tag);
    try { await api('api_leads_update', l.id, { tags: existing.join(', ') }); } catch (_) {}
  }
  toast('Tag added'); clearSelection(); loadLeads();
}
async function bulkDelete() {
  const ids = selectedIds(); if (!ids.length) return;
  if (!await confirmDialog(`Delete ${ids.length} leads? This cannot be undone.`)) return;
  try { await api('api_leads_bulkDelete', ids); toast('Deleted'); clearSelection(); loadLeads(); }
  catch (e) { toast(e.message, 'err'); }
}

/**
 * Delete every lead currently flagged is_duplicate=1, server-side.
 * Admin/manager only. Confirmation prompt with the count first.
 */
async function deleteAllDuplicates() {
  // Surface the duplicates view first so the admin can see what's about
  // to be removed, with the accurate total.
  const sel = document.getElementById('f-duplicate');
  if (sel) sel.value = 'only';
  await loadLeads({ page: 1 });
  const fullCount = Number(CRM.cache.lastTotal) || (CRM.cache.lastLeads || []).length;
  if (!fullCount) {
    toast('No duplicates found. ✨');
    if (sel) sel.value = '';
    await loadLeads({ page: 1 });
    return;
  }
  const msg = `Delete ALL ${fullCount} duplicate lead${fullCount === 1 ? '' : 's'}?\n\n` +
              `This will permanently remove them from the database. ` +
              `Their remarks and follow-ups will also be deleted.\n\n` +
              `This cannot be undone.`;
  if (!await confirmDialog(msg)) return;
  try {
    const r = await api('api_leads_deleteAllDuplicates');
    toast(`✅ Removed ${r.count} duplicate lead${r.count === 1 ? '' : 's'}`);
    if (sel) sel.value = '';
    await loadLeads({ page: 1 });
  } catch (e) { toast(e.message, 'err'); }
}

/* --- CSV export / upload --- */
function exportCSV() {
  const rows = CRM.cache.lastLeads || [];
  if (!rows.length) return toast('No leads to export', 'warn');
  const headers = ['id', 'name', 'phone', 'email', 'whatsapp', 'source', 'product_name', 'status_name', 'assigned_name', 'tags', 'city', 'next_followup_at', 'last_status_change_at', 'notes', 'created_at'];
  const csv = [headers.join(',')].concat(rows.map(r => headers.map(k => {
    const v = r[k] == null ? '' : String(r[k]).replace(/"/g, '""');
    return /[",\n]/.test(v) ? `"${v}"` : v;
  }).join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function openBulkUpload() {
  // Include admin too, since admin may want to assign to themselves
  const users = (CRM.cache.users || []).filter(u => Number(u.is_active ?? 1) === 1);
  const noUsers = users.length === 0;

  let parsedRows = [];
  let assignMode = 'csv';

  // -------- Modal layout --------
  const fileInput = h('input', {
    type: 'file',
    accept: '.csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    id: 'csv-file',
    style: { width: '100%' }
  });
  const fileInfo = h('div', { class: 'muted', id: 'csv-file-info', style: { fontSize: '.85rem', marginTop: '.4rem' } }, 'No file selected. Accepts .csv, .xlsx and .xls.');
  const filePreview = h('div', { class: 'csv-preview', id: 'csv-preview', hidden: true });

  // Mode picker as 4 button cards — no radios, no labels, no flex weirdness.
  const modeCard = (id, icon, title, desc) => h('button', {
    type: 'button',
    class: 'assign-mode-card',
    'data-mode': id,
    onclick: () => { assignMode = id; updateMode(); }
  },
    h('span', { class: 'amc-icon' }, icon),
    h('span', { class: 'amc-content' },
      h('span', { class: 'amc-title' }, title),
      h('span', { class: 'amc-desc' }, desc)
    )
  );
  const modePicker = h('div', { class: 'assign-mode-grid' },
    modeCard('single',      '👤', 'One employee',         'Assign every lead to one person.'),
    modeCard('round_robin', '🔁', 'Round-robin',           'Divide equally between selected employees.'),
    modeCard('percent',     '📊', 'Percentage split',      'Custom share — e.g. 60% / 30% / 10%.'),
    modeCard('csv',         '📄', 'Use CSV value',         'Per-row assigned_to or your assignment rules.')
  );

  // Mode-specific bodies
  const singleSel = h('select', { id: 'assign-single-user', class: 'assign-single-input' },
    h('option', { value: '' }, '— pick employee —'),
    ...users.map(u => h('option', { value: u.id }, `${u.name} (${u.role})`))
  );
  const singleBody = h('div', { class: 'assign-mode-body', 'data-for': 'single', hidden: true, style: { display: 'none' } },
    h('label', {}, 'Assign all leads to:'), singleSel
  );

  const rrChecks = users.map(u => h('label', { class: 'assign-rr-check' },
    h('input', { type: 'checkbox', name: 'rr-user', value: u.id }),
    h('span', {}, ` ${u.name}`),
    h('span', { class: 'muted', style: { fontSize: '.78rem', marginLeft: '.35rem' } }, u.role)
  ));
  const rrBody = h('div', { class: 'assign-mode-body', 'data-for': 'round_robin', hidden: true, style: { display: 'none' } },
    h('label', {}, 'Pick the employees to share these leads:'),
    h('div', { class: 'assign-rr-grid' }, ...rrChecks),
    h('div', { class: 'actions', style: { marginTop: '.5rem' } },
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { rrChecks.forEach(c => c.querySelector('input').checked = true); previewAssignment(); } }, 'Select all'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { rrChecks.forEach(c => c.querySelector('input').checked = false); previewAssignment(); } }, 'Clear')
    )
  );
  rrBody.querySelectorAll('input').forEach(i => i.addEventListener('change', previewAssignment));

  const percentRows = users.map(u => h('div', { class: 'assign-pct-row' },
    h('label', { class: 'assign-pct-name' }, u.name + ' '),
    h('input', { type: 'number', min: 0, max: 100, step: 1, value: 0, 'data-uid': u.id, class: 'assign-pct-input', oninput: previewAssignment }),
    h('span', { class: 'muted' }, '%')
  ));
  const pctTotalEl = h('div', { class: 'assign-pct-total muted', id: 'pct-total' }, 'Total: 0%');
  const percentBody = h('div', { class: 'assign-mode-body', 'data-for': 'percent', hidden: true, style: { display: 'none' } },
    h('label', {}, 'Assign by percentage (must add up to 100%):'),
    h('div', { class: 'assign-pct-grid' }, ...percentRows),
    pctTotalEl
  );

  const csvBody = h('div', { class: 'assign-mode-body', 'data-for': 'csv' },
    h('p', { class: 'muted', style: { fontSize: '.85rem' } },
      'Each row keeps its own ',
      h('code', {}, 'assigned_to'),
      ' value (or stays empty for your assignment rules / round-robin defaults to apply).'
    )
  );

  const previewEl = h('div', { class: 'assign-preview' });
  const importBtn = h('button', { class: 'btn primary', disabled: 'disabled', onclick: doImport }, 'Import');

  function updateMode() {
    [...modePicker.children].forEach(c => c.classList.toggle('active', c.dataset.mode === assignMode));
    modePicker.querySelectorAll('input[type=radio]').forEach(r => r.checked = r.value === assignMode);
    [singleBody, rrBody, percentBody, csvBody].forEach(b => {
      const visible = b.dataset.for === assignMode;
      b.hidden = !visible;
      b.style.display = visible ? '' : 'none';
    });
    previewAssignment();
  }
  singleSel.addEventListener('change', previewAssignment);

  function readPercentSplit() {
    const split = {};
    let total = 0;
    percentRows.forEach(r => {
      const inp = r.querySelector('input');
      const v = Number(inp.value) || 0;
      const uid = Number(inp.dataset.uid);
      if (v > 0 && uid) { split[uid] = v; total += v; }
    });
    return { split, total };
  }

  function previewAssignment() {
    previewEl.innerHTML = '';
    if (!parsedRows.length) {
      importBtn.disabled = 'disabled';
      return;
    }
    const userById = Object.fromEntries(users.map(u => [Number(u.id), u]));
    let plan = [];
    let valid = false;

    if (assignMode === 'csv') {
      valid = true;
      previewEl.appendChild(h('div', { class: 'muted' }, `${parsedRows.length} rows — assignment per row's CSV value or your rules.`));

    } else if (assignMode === 'single') {
      const uid = Number(singleSel.value);
      if (!uid) {
        previewEl.appendChild(h('div', { class: 'muted warn' }, 'Pick an employee to continue.'));
      } else {
        valid = true;
        const u = userById[uid];
        previewEl.appendChild(h('div', {}, `All ${parsedRows.length} leads → `, h('b', {}, u.name)));
      }

    } else if (assignMode === 'round_robin') {
      const ids = [...rrBody.querySelectorAll('input[name=rr-user]:checked')].map(i => Number(i.value));
      if (!ids.length) {
        previewEl.appendChild(h('div', { class: 'muted warn' }, 'Pick at least one employee.'));
      } else {
        valid = true;
        const counts = {};
        for (let i = 0; i < parsedRows.length; i++) {
          const uid = ids[i % ids.length];
          counts[uid] = (counts[uid] || 0) + 1;
        }
        const lines = Object.entries(counts).map(([uid, n]) =>
          h('div', {}, `${userById[Number(uid)]?.name || ('User ' + uid)}: `, h('b', {}, n + ' leads'))
        );
        previewEl.appendChild(h('div', { class: 'preview-grid' }, ...lines));
      }

    } else if (assignMode === 'percent') {
      const { split, total } = readPercentSplit();
      pctTotalEl.textContent = 'Total: ' + total + '%';
      pctTotalEl.classList.toggle('warn', total !== 100);
      pctTotalEl.classList.toggle('ok', total === 100);
      if (total === 100) {
        valid = true;
        const lines = Object.entries(split).map(([uid, pct]) => {
          const n = Math.round((pct / 100) * parsedRows.length);
          return h('div', {}, `${userById[Number(uid)]?.name || ('User ' + uid)}: `, h('b', {}, `${n} leads (${pct}%)`));
        });
        previewEl.appendChild(h('div', { class: 'preview-grid' }, ...lines));
      } else {
        previewEl.appendChild(h('div', { class: 'muted warn' }, 'Percentages must add up to exactly 100%.'));
      }
    }
    importBtn.disabled = (parsedRows.length && valid) ? null : 'disabled';
  }

  fileInput.addEventListener('change', async (e) => {
    parsedRows = [];
    filePreview.hidden = true;
    filePreview.innerHTML = '';
    const f = e.target.files[0];
    if (!f) { fileInfo.textContent = 'No file selected.'; previewAssignment(); return; }
    fileInfo.textContent = '⏳ Parsing ' + f.name + '…';
    try {
      parsedRows = await parseSpreadsheet(f);
      const cols = parsedRows.length ? Object.keys(parsedRows[0]) : [];
      const sample = parsedRows.slice(0, 3);
      fileInfo.textContent = `✅ ${f.name} — ${parsedRows.length} rows · ${cols.length} columns`;

      // -------- Sanity warnings --------
      const warnings = [];
      // 1. Phone fields that came in as scientific notation -> Excel data loss
      const phoneFields = cols.filter(c => /^(phone|mobile|whatsapp|alt_phone|alternate)$/i.test(c));
      let sciPhoneCount = 0;
      const allPhonesSeen = [];
      parsedRows.forEach(r => {
        phoneFields.forEach(f => {
          const v = String(r[f] || '');
          allPhonesSeen.push(v);
          // Detect a phone that ends with a long run of zeros (Excel signature
          // of a sci-notation conversion that lost trailing digits)
          if (/^\d{10,}0{4,}$/.test(v) || /[eE]/.test(v)) sciPhoneCount++;
        });
      });
      if (sciPhoneCount > 0) {
        warnings.push({
          icon: '⚠️',
          msg: `${sciPhoneCount} phone number${sciPhoneCount === 1 ? ' is' : 's are'} in scientific notation — Excel has truncated trailing digits and these numbers are now corrupted. To fix: open your spreadsheet, right-click the Phone column → Format cells → Text, re-enter the numbers, then re-export.`
        });
      }
      // 2. Detect employee column under common alias names
      const userCols = cols.filter(c => /^(user|owner|assignee|sales_rep|salesperson|agent|assigned_user|rep|assigned_to)$/i.test(c));
      if (userCols.length) {
        warnings.push({
          icon: '👤',
          msg: `Detected employee column "${userCols[0]}" — leads will be auto-mapped to employees by name/email match.`,
          ok: true
        });
      }
      // 3. Notice if 'tags' column has status-like values (Duplicate, Lost, etc)
      if (cols.includes('tags')) {
        const dupCount = parsedRows.filter(r => /\b(duplicate|dup)\b/i.test(String(r.tags || ''))).length;
        if (dupCount > 0) {
          warnings.push({
            icon: 'ℹ️',
            msg: `${dupCount} row${dupCount === 1 ? '' : 's'} tagged as "Duplicate" will be flagged is_duplicate=1 (visible under Leads → ⚠️ Duplicates only filter).`,
            ok: true
          });
        }
      }
      if (warnings.length) {
        const wrap = h('div', { class: 'csv-warn-list' }, ...warnings.map(w =>
          h('div', { class: 'csv-warn ' + (w.ok ? 'ok' : 'warn') },
            h('span', { class: 'csv-warn-ico' }, w.icon),
            h('span', {}, w.msg)
          )
        ));
        filePreview.appendChild(wrap);
      }

      if (sample.length) {
        const tbl = h('table', { class: 'mini-table csv-preview-table' });
        const thead = h('thead', {}, h('tr', {}, ...cols.map(c => h('th', {}, c))));
        const tbody = h('tbody', {}, ...sample.map(r => h('tr', {}, ...cols.map(c => h('td', {}, String(r[c] || ''))))));
        tbl.append(thead, tbody);
        filePreview.appendChild(h('div', { class: 'muted', style: { fontSize: '.78rem', margin: '.5rem 0 .35rem' } }, 'Preview — first 3 rows:'));
        filePreview.appendChild(tbl);
        filePreview.hidden = false;
      }
      previewAssignment();
    } catch (err) {
      fileInfo.textContent = '⚠️ Could not parse file: ' + err.message;
    }
  });

  async function doImport() {
    if (!parsedRows.length) return toast('Choose a file first', 'warn');
    let assign;
    if (assignMode === 'csv') {
      assign = { mode: 'csv' };
    } else if (assignMode === 'single') {
      const uid = Number(singleSel.value);
      if (!uid) return toast('Pick an employee', 'warn');
      assign = { mode: 'single', user_id: uid };
    } else if (assignMode === 'round_robin') {
      const ids = [...rrBody.querySelectorAll('input[name=rr-user]:checked')].map(i => Number(i.value));
      if (!ids.length) return toast('Pick at least one employee', 'warn');
      assign = { mode: 'round_robin', user_ids: ids };
    } else if (assignMode === 'percent') {
      const { split, total } = readPercentSplit();
      if (total !== 100) return toast('Percentages must sum to 100%', 'warn');
      assign = { mode: 'percent', split };
    }
    importBtn.disabled = 'disabled';
    importBtn.textContent = 'Importing…';
    try {
      const r = await api('api_leads_bulkCreate', parsedRows, assign);
      const lines = [`✅ Imported ${r.created} of ${parsedRows.length}`];
      if (r.duplicate) lines.push(`${r.duplicate} duplicates`);
      if (r.skipped) lines.push(`${r.skipped} skipped`);
      toast(lines.join(' · '));
      modal.remove();
      loadLeads();
    } catch (e) {
      toast(e.message, 'err');
      importBtn.disabled = null;
      importBtn.textContent = 'Import';
    }
  }

  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' }, h('h3', {}, '⬆️ Bulk upload leads'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('p', { class: 'muted' }, 'Step 1: pick a CSV or Excel (.xlsx) file. Columns: name, phone, email, whatsapp, source, product, status, notes, city, tags, next_followup_at, assigned_to, plus any custom field keys. The status and product columns accept names — unknown values are auto-created.'),
      h('p', { class: 'muted', style: { fontSize: '.82rem' } },
        h('b', {}, 'Tip: '), 'You can pre-assign leads to specific employees by adding an ',
        h('code', {}, 'assigned_to'),
        ' column with the rep\'s email or full name. Or use Step 2 below to assign in bulk.'
      ),
      fileInput,
      fileInfo,
      filePreview,
      h('p', { style: { marginTop: '1rem' } }, h('a', { href: '/api/sample.csv', download: '' }, '⬇️ Download sample CSV')),
      h('h4', { style: { marginTop: '1.5rem' } }, 'Step 2: how should these leads be assigned?'),
      modePicker,
      singleBody, rrBody, percentBody, csvBody,
      h('div', { class: 'assign-preview-wrap' },
        h('h5', { style: { margin: '1rem 0 .5rem' } }, 'Preview'),
        previewEl
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        importBtn
      )
    )
  );
  document.body.appendChild(modal);
  updateMode();
}
/* ---------------- Spreadsheet parsing (CSV + XLSX) ---------------- */

/** Lazy-load SheetJS only when the user actually opens an Excel file. */
let _xlsxLib = null;
async function ensureXLSX() {
  if (window.XLSX) return window.XLSX;
  if (_xlsxLib) return _xlsxLib;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  _xlsxLib = window.XLSX;
  return _xlsxLib;
}

/** Normalize a column header into a snake_case key (lowercase, spaces+dashes → _). */
function normalizeKey(k) {
  return String(k || '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}

/**
 * Clean up a single cell value:
 *  - convert numbers to strings (Excel returns numbers for digit cells)
 *  - strip leading apostrophe (Excel uses ' to force text)
 *  - strip BOM, trim whitespace
 *  - convert scientific-notation phone numbers back to plain digits
 *  - lowercase + trim emails
 */
function cleanCell(key, val) {
  if (val == null) return '';
  if (val instanceof Date && !isNaN(val)) return val.toISOString();
  if (typeof val === 'number') val = String(val);
  let s = String(val).replace(/^﻿/, '').trim();
  s = s.replace(/^'/, '');
  // Scientific notation? Reconstruct (e.g. "9.876543E+9" → "9876543000")
  if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(s)) {
    const n = Number(s);
    if (!isNaN(n) && isFinite(n)) s = String(n.toFixed(0));
  }
  if (key === 'email') s = s.toLowerCase();
  return s;
}

/**
 * Parse a CSV or XLSX file → array of normalized row objects.
 * Handles BOM, multi-line cells, Excel quirks, scientific-notation phones.
 */
async function parseSpreadsheet(file) {
  const name = (file.name || '').toLowerCase();
  // ---- XLSX / XLS path ----
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) {
    const XLSX = await ensureXLSX();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true, raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, blankrows: false });
    return rows.map(r => {
      const out = {};
      for (const [k, v] of Object.entries(r)) {
        const key = normalizeKey(k);
        out[key] = cleanCell(key, v);
      }
      return out;
    }).filter(r => Object.values(r).some(v => v !== ''));
  }
  // ---- CSV path ----
  let text = await file.text();
  text = text.replace(/^﻿/, ''); // strip UTF-8 BOM (Excel always adds one)
  const rows = parseCSVText(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map(normalizeKey);
  return rows.slice(1).map(line => {
    if (line.every(c => c === '' || c == null)) return null;
    const o = {};
    headers.forEach((h, i) => { o[h] = cleanCell(h, line[i]); });
    return o;
  }).filter(Boolean);
}

/**
 * Full CSV parser — handles quoted multi-line fields, escaped quotes,
 * CRLF or LF line endings. Returns an array of arrays.
 */
function parseCSVText(text) {
  const out = [];
  let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++; // swallow LF after CR
        row.push(cur); cur = '';
        out.push(row); row = [];
      } else cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row); }
  return out.filter(r => r.length > 1 || (r[0] && r[0].trim()));
}

// Backwards-compat shim — older code calls parseCSV(text) on already-loaded text
function parseCSV(text) {
  const stripped = String(text || '').replace(/^﻿/, '');
  const rows = parseCSVText(stripped);
  if (rows.length === 0) return [];
  const headers = rows[0].map(normalizeKey);
  return rows.slice(1).map(line => {
    if (line.every(c => c === '' || c == null)) return null;
    const o = {};
    headers.forEach((h, i) => { o[h] = cleanCell(h, line[i]); });
    return o;
  }).filter(Boolean);
}

/* --- Column chooser --- */
function openColumnChooser() {
  const active = new Set(getActiveColumns());
  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, 'Columns'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('p', { class: 'muted' }, 'Pick which columns to show. Saved as your default view.'),
      h('div', { class: 'col-picker' },
        ...LEAD_COLUMNS.map(c => h('label', { class: 'col-opt' },
          h('input', { type: 'checkbox', value: c.key, checked: active.has(c.key) ? 'checked' : null }),
          h('span', {}, c.label)
        ))
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          const keys = $$('.col-picker input:checked', modal).map(i => i.value);
          CRM.prefs.columns = keys;
          localStorage.setItem('crm_cols', JSON.stringify(keys));
          modal.remove();
          loadLeads();
        } }, 'Save default view')
      )
    )
  );
  document.body.appendChild(modal);
}

/* --- Lead modal --- */
async function openLeadModal(id) {
  const { statuses, sources, products, users, customFields } = CRM.cache;
  // Lazy-load the admin-managed tag library; cached for the session.
  if (!CRM.cache.tagLibrary) {
    try { CRM.cache.tagLibrary = await api('api_tags_list'); } catch (_) { CRM.cache.tagLibrary = []; }
  }
  const tagLibrary = CRM.cache.tagLibrary || [];
  const isAdmin = CRM.user.role === 'admin';
  let lead = { name: '', phone: '', email: '', whatsapp: '', source: '', status_id: statuses[0]?.id, assigned_to: CRM.user.id, notes: '', tags: '', next_followup_at: '', qualified: 0 };
  let remarks = [];
  if (id) {
    const r = await api('api_leads_get', id);
    lead = Object.assign(lead, r.lead || r);
    remarks = r.remarks || [];
  }
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  modal.appendChild(body);
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, id ? 'Edit Lead' : 'New Lead'),
    lead.is_duplicate ? h('span', { class: 'dup-pill', onclick: () => openDuplicateHistory(id) }, 'DUPLICATE of #' + (lead.duplicate_of || '?')) : null,
    Number(lead.qualified) === 1 ? h('span', { class: 'qual-pill ok' }, '✓ Qualified') : null,
    h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
  ));

  // Quick actions row — front-and-centre Call / personal WA / Cloud-API
  // template / Calendly buttons so reps don't have to hunt for them in
  // the leads table. Only shows on existing leads with a phone number.
  if (id && lead.phone) {
    const _digits = String(lead.phone || '').replace(/\D/g, '');
    const _intl = _digits.length === 10 && /^[6-9]/.test(_digits) ? '91' + _digits : _digits;
    body.appendChild(h('div', { class: 'card', style: { padding: '.6rem .8rem', margin: '0 0 .75rem', display: 'flex', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' } },
      h('span', { class: 'muted', style: { fontSize: '.78rem', marginRight: '.25rem' } }, 'Quick actions:'),
      _digits ? h('button', { type: 'button', class: 'btn sm btn-call', onclick: () => callLead(lead) }, '📞 Call') : null,
      _digits ? h('button', {
        type: 'button', class: 'btn sm',
        onclick: () => openPersonalWaPicker(lead),
        title: 'Pick a template — opens WhatsApp from MY number with text pre-filled'
      }, '💬 My WhatsApp') : null,
      _digits ? h('button', { type: 'button', class: 'btn sm wa-cloud-btn', onclick: () => openInitiateChatModal(lead) }, '🟢 WA Template') : null,
      _digits ? h('button', { type: 'button', class: 'btn sm', onclick: () => sendCalendlyLink(lead) }, '📅 Send Calendly') : null,
      lead.email ? h('a', { class: 'btn sm', href: 'mailto:' + lead.email }, '✉ Email') : null
    ));
  }

  const form = h('form', { id: 'lead-form', class: 'form-grid' });
  form.append(
    field('name', 'Name *', lead.name, { required: true }),
    field('phone', 'Phone *', lead.phone, { required: true }),
    field('whatsapp', 'WhatsApp', lead.whatsapp || lead.phone),
    field('email', 'Email', lead.email, { type: 'email' }),
    selectField('source', 'Source', lead.source, sources.map(s => s.name)),
    selectField('product_id', 'Product', lead.product_id, [{ value: '', label: '—' }, ...products.map(p => ({ value: p.id, label: p.name }))]),
    selectField('status_id', 'Status', lead.status_id, statuses.map(s => ({ value: s.id, label: s.name })), { id: 'lead-status' }),
    selectField('assigned_to', 'Assigned To', lead.assigned_to, users.map(u => ({ value: u.id, label: u.name }))),
    tagsInput(lead.tags, tagLibrary, isAdmin),
    field('next_followup_at', 'Next follow-up', isoToLocalDtInput(lead.next_followup_at), { type: 'datetime-local', id: 'lead-fu' }),
    field('city', 'City', lead.city),
    qualifiedToggle(lead),
    // Inventory matching inputs — used by api_inventory_match. Reps fill
    // these on the lead form so the "Matching inventory" panel below can
    // suggest items the prospect's actually likely to buy.
    field('budget_max', 'Budget (max ₹)', lead.budget_max, { type: 'number', min: 0, step: 1 }),
    field('requirement_type', 'Requirement type (e.g. 2BHK, Plot, Premium plan)', lead.requirement_type),
    field('requirement_notes', 'Requirement notes', lead.requirement_notes, { type: 'textarea', full: true }),
    field('notes', 'Notes', lead.notes, { type: 'textarea', full: true })
  );

  // Hide any custom field that collides with a hardcoded built-in field key —
  // otherwise the user sees Budget / Requirement type / Requirement notes
  // twice (once as the inventory-matching inputs above, once as the custom
  // field they originally created in Admin). The hardcoded version wins
  // because it's what api_inventory_match reads from.
  const RESERVED_FIELD_KEYS = new Set([
    'budget_max', 'requirement_type', 'requirement_notes',
    'name', 'phone', 'email', 'city', 'notes', 'tags',
    'status_id', 'assigned_to', 'next_followup_at', 'qualified',
    'source_id', 'product_id'
  ]);
  (customFields || []).forEach(cf => {
    if (RESERVED_FIELD_KEYS.has(String(cf.key || '').toLowerCase())) return;
    const extra = lead.extra || {};
    form.appendChild(customFieldInput(cf, extra[cf.key]));
  });

  body.appendChild(form);

  // Customer / campaign-supplied fields are read-only for non-admins on
  // existing leads. Reps can update status/notes/follow-up/etc. but cannot
  // overwrite what the customer typed in the form, the source, the GCLID,
  // or the UTMs. Admin can still change these for legitimate corrections.
  if (id && !isAdmin) {
    const LOCKED = ['name', 'phone', 'whatsapp', 'email', 'source'];
    LOCKED.forEach(name => {
      const el = form.querySelector(`[name="${name}"]`);
      if (!el) return;
      el.readOnly = true;
      el.disabled = (el.tagName === 'SELECT'); // <select> needs disabled, not readonly
      el.title = 'Locked — set by the campaign / customer. Only admin can edit.';
      el.classList.add('lead-locked');
      // Append a lock badge to the field's label so users see immediately
      // why they can't type.
      const label = el.closest('.f-row')?.querySelector('label')
                 || el.parentElement?.querySelector('label');
      if (label && !label.querySelector('.locked-badge')) {
        const badge = h('span', { class: 'locked-badge', title: 'Set by campaign — only admin can edit' }, ' 🔒');
        label.appendChild(badge);
      }
    });
  }

  if (id) body.appendChild(projectStageBlock(id, lead));
  if (id) body.appendChild(matchingInventoryBlock(id));
  if (id) body.appendChild(actionTimelineBlock(id));
  if (id) body.appendChild(remarksBlock(remarks, id));
  if (id) body.appendChild(recordingsBlock(id));
  // Action row — Cancel / Save / [Duplicate & reassign for managers+]
  const actionsRow = h('div', { class: 'actions' });
  actionsRow.appendChild(h('button', { type: 'button', class: 'btn', onclick: () => modal.remove() }, 'Cancel'));
  if (id && ['admin', 'manager', 'team_leader'].includes(CRM.user.role)) {
    actionsRow.appendChild(h('button', { type: 'button', class: 'btn', onclick: () => openDuplicateAndReassignModal(id, lead, () => { modal.remove(); loadLeads && loadLeads(); }) }, '📋 Duplicate & reassign'));
  }
  actionsRow.appendChild(h('button', { type: 'submit', form: 'lead-form', class: 'btn primary' }, id ? 'Save changes' : 'Create lead'));
  body.appendChild(actionsRow);
  document.body.appendChild(modal);

  // Status → Follow-up enforcement: when the user picks a status whose
  // name is "Follow Up", they MUST also pick a date+time. The submit
  // handler validates this and blocks save with a clear message.
  function selectedStatusName() {
    const sel = form.querySelector('[name="status_id"]');
    if (!sel) return '';
    const opt = sel.options[sel.selectedIndex];
    return (opt ? opt.textContent : '').trim().toLowerCase();
  }

  // When the rep flips status to a "dead-end" one (Not Pick, Not Interested,
  // Junk, Does Not Exist, Broker) we strip the HTML5 `required` attribute
  // from custom fields so they can save the lead without filling capital
  // range / risk tolerance / etc. JS validation below honours the same rule.
  function syncRequiredFromStatus() {
    const skip = _statusSkipsRequired(selectedStatusName());
    form.querySelectorAll('[data-cf-required="1"]').forEach(el => {
      if (skip) el.removeAttribute('required');
      else      el.setAttribute('required', '');
    });
  }
  const _statusSel = form.querySelector('[name="status_id"]');
  if (_statusSel) _statusSel.addEventListener('change', syncRequiredFromStatus);
  syncRequiredFromStatus();

  form.addEventListener('submit', async ev => {
    ev.preventDefault();

    // Status = "Follow Up" requires next_followup_at — both date AND time.
    const statusName = selectedStatusName();
    const fuVal = form.querySelector('[name="next_followup_at"]')?.value || '';
    if (/follow\s*up/i.test(statusName) && !fuVal) {
      toast('Status "Follow Up" requires a next follow-up date and time', 'err');
      form.querySelector('[name="next_followup_at"]')?.focus();
      return;
    }

    // Required custom fields — enforce here in addition to HTML5 `required`.
    // Admin is exempt: they often need to update a lead in flight (e.g.
    // change status, add a note) without re-typing every required field
    // that the rep should have filled. Other roles still get the validation.
    // Also exempt: when the chosen status marks the lead as a dead-end
    // (Not Pick, Not Interested, Junk, Does Not Exist, Broker) — pointless
    // to demand custom-field detail for leads that aren't progressing.
    const _skipRequired = _statusSkipsRequired(statusName);
    if (CRM.user.role !== 'admin' && !_skipRequired) {
      for (const cf of (customFields || [])) {
        if (!cf.is_required) continue;
        const key = 'cf_' + cf.key;
        let val;
        if (cf.field_type === 'multiselect') val = (new FormData(form)).getAll(key).join(',');
        else val = form.querySelector(`[name="${key}"]`)?.value || '';
        if (!String(val).trim()) {
          toast(`"${cf.label}" is required`, 'err');
          const el = form.querySelector(`[name="${key}"]`);
          if (el && el.focus) el.focus();
          return;
        }
      }
    }

    const fd = new FormData(form);
    const extra = {};
    (customFields || []).forEach(cf => {
      const key = 'cf_' + cf.key;
      if (cf.field_type === 'multiselect') extra[cf.key] = fd.getAll(key).join(',');
      else extra[cf.key] = fd.get(key) || '';
    });
    // Tags: if non-admin, the tags field is a multi-select — collect with getAll.
    const tagsValue = isAdmin
      ? (fd.get('tags') || '')
      : fd.getAll('tags[]').join(',');
    const payload = {
      name: fd.get('name'), phone: fd.get('phone'), email: fd.get('email'),
      whatsapp: fd.get('whatsapp'), source: fd.get('source'),
      product_id: Number(fd.get('product_id')) || null,
      status_id: Number(fd.get('status_id')) || null,
      assigned_to: Number(fd.get('assigned_to')) || null,
      tags: tagsValue,
      next_followup_at: localDtInputToIso(fd.get('next_followup_at')),
      city: fd.get('city'), notes: fd.get('notes'),
      qualified: form.querySelector('[name="qualified"]')?.checked ? 1 : 0,
      // Inventory matching inputs
      budget_max:        Number(fd.get('budget_max')) || null,
      requirement_type:  fd.get('requirement_type') || '',
      requirement_notes: fd.get('requirement_notes') || '',
      extra
    };
    try {
      if (id) await api('api_leads_update', id, payload);
      else    await api('api_leads_create', payload);
      toast(id ? 'Saved' : 'Created');
      modal.remove();
      loadLeads();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/**
 * Build the Tags form row.
 * - Admin → freeform comma-separated input AND can add new tags from this UI
 *   (still suggested values dropdown via datalist).
 * - Non-admin → multi-select of existing tags only. Cannot type new ones.
 */
function tagsInput(currentTags, tagLibrary, isAdmin) {
  const current = String(currentTags || '').split(',').map(s => s.trim()).filter(Boolean);
  if (isAdmin) {
    // Free-form input plus a datalist of known tags for autocomplete.
    const dlId = 'tag-suggest-' + Math.random().toString(36).slice(2, 8);
    const inp = h('input', { name: 'tags', value: current.join(', '), list: dlId, placeholder: 'comma separated' });
    const dl  = h('datalist', { id: dlId }, ...tagLibrary.map(t => h('option', { value: t.name })));
    return h('div', { class: 'f-row' }, h('label', {}, 'Tags'), h('div', {}, inp, dl,
      h('div', { class: 'muted', style: { fontSize: '.75rem', marginTop: '.25rem' } },
        'Manage the master tag list under Admin → Tags.'))
    );
  }
  // Non-admin: multi-select. Cannot type new tags.
  if (tagLibrary.length === 0) {
    return h('div', { class: 'f-row' }, h('label', {}, 'Tags'),
      h('div', { class: 'muted' }, 'No tags available. Ask an admin to add them under Admin → Tags.'));
  }
  const grid = h('div', { class: 'cf-multi-grid' },
    ...tagLibrary.map(t => h('label', {},
      h('input', { type: 'checkbox', name: 'tags[]', value: t.name, checked: current.includes(t.name) ? 'checked' : null }),
      ' ', h('span', { class: 'tag', style: { background: t.color, color: '#fff' } }, t.name)
    ))
  );
  return h('div', { class: 'f-row full' }, h('label', {}, 'Tags'), grid);
}

function qualifiedToggle(lead) {
  const wrap = h('div', { class: 'f-row' },
    h('label', {}, 'Qualified lead?'),
    h('label', { class: 'qual-toggle' },
      h('input', { type: 'checkbox', name: 'qualified', checked: Number(lead.qualified) === 1 ? 'checked' : null }),
      h('span', {}, ' Mark as qualified (passes minimum criteria, separate from status)')
    )
  );
  return wrap;
}

/**
 * Pop up a small modal with a user picker and a confirm button. On confirm,
 * call api_leads_duplicateAndReassign. Used from the lead modal.
 */
/**
 * "Next Follow Up" modal — replaces the old "Mark done" button.
 *
 * Forces the user to commit to a NEXT step instead of just dismissing the
 * reminder. They pick a new date+time and write a quick remark; we then:
 *  1. Insert a remark on the lead (so it's visible in history)
 *  2. Update the lead's next_followup_at (which auto-syncs the followup row)
 *  3. Close this modal & refresh
 *
 * If the user enters a remark but leaves date blank, we treat it as a Done +
 * remark (close current followup, no next one).
 */
function openNextFollowupModal(row, onSuccess) {
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  // Default next due = tomorrow at 10am local
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow.setHours(10, 0, 0, 0);
  const defaultDt = isoToLocalDtInput(tomorrow.toISOString());

  // Status picker — lets the rep change the lead's status while resolving the
  // follow-up. For "dead-end" statuses (Not Picked, Not Interested, Junk,
  // Does Not Exist, Broker) we drop the next-follow-up requirement because
  // the lead isn't progressing, so a fresh follow-up date is pointless.
  const statuses = (CRM.cache.statuses || []);
  const statusSel = h('select', { class: 'status-picker' },
    h('option', { value: '' }, '— Keep current status —'),
    ...statuses.map(s => h('option', { value: s.id }, s.name))
  );

  const dtInput  = h('input', { type: 'datetime-local', value: defaultDt });
  const dtLabel  = h('label', {}, 'Next follow-up date & time *');
  const dtHint   = h('p', { class: 'muted', style: { fontSize: '.78rem', margin: '.25rem 0 0' } },
    'When should you contact this lead next?');

  const remarkInput = h('textarea', { rows: 3, placeholder: 'What happened on this call / contact attempt?' });

  // Toggle the required indicator + hint based on the selected status.
  function syncFollowupRequired() {
    const opt = statusSel.options[statusSel.selectedIndex];
    const name = (opt ? opt.textContent : '').trim();
    const skip = _statusSkipsRequired(name);
    dtLabel.textContent = skip ? 'Next follow-up date & time (optional)' : 'Next follow-up date & time *';
    dtHint.textContent  = skip
      ? 'Optional — this status closes the lead, no further follow-up needed.'
      : 'When should you contact this lead next?';
  }
  statusSel.addEventListener('change', syncFollowupRequired);
  syncFollowupRequired();

  m.appendChild(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' },
      h('h3', {}, '⏰ Next follow-up'),
      h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
    ),
    h('p', { class: 'muted', style: { marginTop: 0 } },
      `For lead: ${row.lead_name || '—'}${row.lead_phone ? ' · ' + row.lead_phone : ''}`),
    h('div', { class: 'f-row full' }, h('label', {}, 'Update status'), statusSel),
    h('div', { class: 'f-row full' }, h('label', {}, 'Remark *'), remarkInput),
    h('div', { class: 'f-row full' }, dtLabel, dtInput, dtHint),
    h('div', { class: 'actions', style: { marginTop: '1rem' } },
      h('button', { class: 'btn', onclick: () => m.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const remark = String(remarkInput.value || '').trim();
        if (!remark) { toast('Remark is required', 'err'); remarkInput.focus(); return; }

        const newStatusId = statusSel.value ? Number(statusSel.value) : null;
        const newStatusOpt = newStatusId ? statusSel.options[statusSel.selectedIndex] : null;
        const newStatusName = newStatusOpt ? newStatusOpt.textContent.trim() : '';
        const skipFollowup = newStatusName ? _statusSkipsRequired(newStatusName) : false;
        const nextIso = localDtInputToIso(dtInput.value);

        // Validate: for non-dead-end statuses, require a next-follow-up date.
        // Dead-end statuses (Not Picked, Not Interested, Junk, Does Not Exist,
        // Broker) skip this gate so the rep can close the lead in one click.
        if (!skipFollowup && !nextIso) {
          toast('Pick a next follow-up date & time, or set a closing status (Junk / Not Interested / etc.)', 'err');
          dtInput.focus();
          return;
        }

        try {
          // 1. Update the lead's status if a new one was picked
          if (newStatusId) {
            try {
              await api('api_leads_update', row.lead_id, { status_id: newStatusId });
            } catch (e) {
              toast('Status update failed: ' + e.message, 'err');
              return;
            }
          }
          // 2. Add the remark and (optionally) set the next followup
          await api('api_leads_addRemark', row.lead_id, {
            remark,
            next_followup_at: nextIso || null
          });
          // 3. Close the current open followup so it leaves Overdue / Due today
          if (row.id) {
            try { await api('api_followup_done', row.id); } catch (_) {}
          }
          toast(skipFollowup
            ? 'Lead updated · status closed'
            : (nextIso ? 'Saved & next follow-up scheduled' : 'Saved'));
          m.remove();
          if (typeof onSuccess === 'function') onSuccess();
        } catch (e) { toast(e.message, 'err'); }
      } }, 'Save')
    )
  ));
  document.body.appendChild(m);
}

function openDuplicateAndReassignModal(leadId, lead, onSuccess) {
  const { users } = CRM.cache;
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const sel = h('select', {},
    h('option', { value: '' }, '— pick a sales user —'),
    ...users.filter(u => Number(u.id) !== Number(lead.assigned_to)).map(u =>
      h('option', { value: u.id }, `${u.name} (${u.role})`))
  );
  m.appendChild(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' },
      h('h3', {}, '📋 Duplicate & reassign'),
      h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
    ),
    h('p', { class: 'muted' },
      `A copy of "${lead.name || ('Lead #' + leadId)}" will be created with status "New" and assigned to the user you pick. The original lead stays as-is.`),
    h('label', {}, 'New assignee'),
    sel,
    h('div', { class: 'actions', style: { marginTop: '1rem' } },
      h('button', { class: 'btn', onclick: () => m.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const newId = sel.value;
        if (!newId) { toast('Pick a user first', 'err'); return; }
        try {
          const r = await api('api_leads_duplicateAndReassign', leadId, Number(newId));
          toast('Duplicated as lead #' + r.id, 'ok');
          m.remove();
          if (typeof onSuccess === 'function') onSuccess();
        } catch (e) { toast(e.message, 'err'); }
      } }, 'Duplicate & reassign')
    )
  ));
  document.body.appendChild(m);
}

function field(name, label, value, opts = {}) {
  const tag = opts.type === 'textarea' ? 'textarea' : 'input';
  const attrs = Object.assign({ name, value: value ?? '' },
    opts.type && opts.type !== 'textarea' ? { type: opts.type } : {},
    opts.required ? { required: true } : {},
    opts.id ? { id: opts.id } : {});
  const el = h(tag, attrs);
  if (opts.type === 'textarea') el.textContent = value ?? '';
  return h('div', { class: opts.full ? 'f-row full' : 'f-row' }, h('label', {}, label), el);
}
function selectField(name, label, value, options, opts = {}) {
  const selAttrs = { name };
  if (opts.id) selAttrs.id = opts.id;
  const sel = h('select', selAttrs,
    ...options.map(o => {
      const v = typeof o === 'object' ? o.value : o;
      const t = typeof o === 'object' ? o.label : o;
      return h('option', { value: v, selected: String(value) === String(v) ? 'selected' : null }, t);
    })
  );
  return h('div', { class: opts.full ? 'f-row full' : 'f-row' }, h('label', {}, label), sel);
}
function selectOpts(id, items, value) {
  return h('select', { id },
    ...items.map(i => h('option', { value: i.id, selected: String(value) === String(i.id) ? 'selected' : null }, i.name))
  );
}
function parseFieldOptions(raw) {
  // Lenient parser: accept pipe-, comma-, or newline-separated lists.
  // Backwards compatible with existing pipe-separated data.
  return String(raw || '').split(/[|,\n]/).map(s => s.trim()).filter(Boolean);
}
// Statuses that mark a lead as "dead-end" and DON'T need the rep to fill
// the full mandatory custom-field set (no point asking for capital range,
// risk tolerance, etc. when the lead never picked up or said no).
// Matched case-insensitively against status name.
const SKIP_REQUIRED_STATUSES = [
  'not pick', 'not picked', 'not picking',
  'not interested',
  'junk', 'spam',
  'does not exist', 'doesnt exist', "doesn't exist", 'invalid',
  'broker'
];
function _statusSkipsRequired(statusName) {
  const n = String(statusName || '').toLowerCase().trim();
  return SKIP_REQUIRED_STATUSES.some(s => n.includes(s));
}

function customFieldInput(cf, val) {
  const name = 'cf_' + cf.key;
  const opts = parseFieldOptions(cf.options);
  // Required attribute on the underlying input — backed up by JS validation
  // in the lead-modal submit handler so multi-select / checkbox cases also
  // work. Admins are exempt from required-field enforcement (they often
  // need to update status / notes without re-typing every required field
  // the rep should have filled). Skip the HTML5 `required` attribute for
  // admins so the browser-level "Please select an item in the list"
  // popup doesn't fire either.
  // Required fields are also tagged with data-cf-required="1" so the lead
  // form can dynamically toggle the `required` attribute when the user
  // picks a "dead-end" status (Not Pick / Not Interested / Junk / etc.).
  const reqAttr = (cf.is_required && CRM.user?.role !== 'admin') ? { required: true } : {};
  if (cf.is_required && CRM.user?.role !== 'admin') reqAttr['data-cf-required'] = '1';
  let input;
  if (cf.field_type === 'textarea') input = h('textarea', Object.assign({ name }, reqAttr), val || '');
  else if (cf.field_type === 'select') input = h('select', Object.assign({ name }, reqAttr),
    h('option', { value: '' }, '—'),
    ...opts.map(o => h('option', { value: o, selected: val === o ? 'selected' : null }, o)));
  else if (cf.field_type === 'multiselect') {
    // Render as a checkbox grid instead of a native <select multiple>.
    // Native multi-select requires Ctrl/Cmd+click and is unusable on touch.
    // FormData.getAll('cf_<key>') still returns the same array of checked values,
    // so the existing save logic at line ~1549 works unchanged.
    const selectedSet = new Set(String(val || '').split(',').map(s => s.trim()).filter(Boolean));
    if (opts.length === 0) {
      input = h('div', { class: 'cf-opts-help' },
        '⚠️ No options defined yet — add some in Admin → Custom fields.');
    } else {
      input = h('div', { class: 'cf-multi-grid' },
        ...opts.map(o => h('label', {},
          h('input', { type: 'checkbox', name, value: o, checked: selectedSet.has(o) ? 'checked' : null }),
          ' ', o
        ))
      );
    }
  }
  else if (cf.field_type === 'checkbox') input = h('input', { type: 'checkbox', name, checked: val ? 'checked' : null, value: '1' });
  else input = h('input', Object.assign({ name, value: val || '', type: cf.field_type === 'number' ? 'number' : cf.field_type === 'date' ? 'date' : 'text' }, reqAttr));
  // Long-form fields span both columns in the grid for breathing room.
  const rowClass = (cf.field_type === 'multiselect' || cf.field_type === 'textarea') ? 'f-row full' : 'f-row';
  return h('div', { class: rowClass }, h('label', {}, cf.label + (cf.is_required ? ' *' : '')), input);
}

/**
 * Action timeline block — fetches lead_actions for this lead and shows
 * a vertical timeline: Created → 1st action → 2nd action → … with the
 * minutes elapsed since lead-create next to each step.
 *
 * Always renders a placeholder while loading; on failure, hides itself
 * silently so the modal remains usable on older deploys.
 */
/**
 * Post-sale project stage tracker block. Shown on every lead detail —
 * if no stages defined yet, shows a hint pointing admin to Settings.
 * If stages exist and the lead has no current stage, shows a "Start
 * delivery tracker" button that sets the first stage. If the lead is
 * mid-flow, shows a horizontal progress strip with the current step
 * highlighted, and an "Advance to next" button.
 */
function projectStageBlock(leadId, lead) {
  const wrap = h('div', { class: 'card', style: { marginTop: '1rem', padding: '1rem' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.5rem' } },
      h('h4', { style: { margin: 0, flex: 1 } }, '🚚 Post-sale delivery'),
      h('span', { class: 'muted', style: { fontSize: '.78rem' } }, 'Stage tracker for what happens after the sale')
    ),
    h('div', { class: 'muted' }, 'Loading…')
  );
  (async () => {
    try {
      const stages = await api('api_projectStages_list');
      const body = wrap.lastChild;
      if (!stages.length) {
        body.replaceWith(h('p', { class: 'muted', style: { margin: 0 } },
          'No stages defined yet. Admin can set them up under Settings → 🚚 Project stages.'));
        return;
      }
      const currentId = Number(lead.project_stage_id) || 0;
      const idx = stages.findIndex(s => Number(s.id) === currentId);
      const isLast = idx === stages.length - 1;
      // Progress strip
      const strip = h('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: '.35rem', marginBottom: '.75rem' }
      });
      stages.forEach((s, i) => {
        const isPast = idx > i;
        const isCurrent = idx === i;
        strip.appendChild(h('span', {
          style: {
            padding: '.3rem .6rem', borderRadius: '999px', fontSize: '.75rem', fontWeight: 600,
            background: isCurrent ? '#3b82f6' : (isPast ? '#10b981' : '#e5e7eb'),
            color: isCurrent || isPast ? '#fff' : '#6b7280'
          },
          title: s.description || ''
        }, (isPast ? '✓ ' : (isCurrent ? '▶ ' : '')) + s.name));
      });
      const advanceBtn = (idx < stages.length - 1) ? h('button', {
        class: 'btn primary', onclick: async () => {
          const notes = prompt('Optional notes for this transition (e.g. cheque #, doc reference):', '') || '';
          try {
            const r = await api('api_projectStages_advanceLead', leadId, notes);
            toast('Advanced to: ' + r.stage_name);
            // Re-render the modal so the new stage shows. Easiest path: close and reopen.
            const modal = document.querySelector('.modal-backdrop');
            if (modal) modal.remove();
            openLeadModal(leadId);
          } catch (e) { toast(e.message, 'err'); }
        }
      }, idx < 0 ? '▶ Start delivery tracker' : '➡ Advance to next stage') : null;
      const setBtn = h('button', {
        class: 'btn', onclick: () => {
          const choices = stages.map(s => '#' + s.sort_order + ' — ' + s.name).join('\n');
          const ans = prompt('Jump to stage by typing its number (#):\n\n' + choices, '');
          if (!ans) return;
          const num = Number(ans.replace(/[^\d]/g, ''));
          const target = stages.find(s => Number(s.sort_order) === num);
          if (!target) return toast('Unknown stage number', 'err');
          const notes = prompt('Optional notes:', '') || '';
          api('api_projectStages_setForLead', leadId, target.id, notes)
            .then(r => {
              toast('Set to: ' + r.stage_name);
              const modal = document.querySelector('.modal-backdrop');
              if (modal) modal.remove();
              openLeadModal(leadId);
            })
            .catch(e => toast(e.message, 'err'));
        }
      }, '↪ Jump to specific stage');
      const summary = h('div', { class: 'muted', style: { fontSize: '.85rem', marginBottom: '.6rem' } },
        idx < 0 ? 'Tracker not started yet — click below to enter the first stage.'
        : isLast ? '✅ On the final stage (' + stages[idx].name + ').'
        : '▶ Currently at: ' + stages[idx].name +
          (lead.project_stage_started_at ? ' · since ' + fmtDate(lead.project_stage_started_at, 'relative') : '')
      );
      const actionsRow = h('div', { class: 'actions', style: { gap: '.5rem' } });
      if (advanceBtn) actionsRow.appendChild(advanceBtn);
      actionsRow.appendChild(setBtn);
      const newBody = h('div', {}, strip, summary, actionsRow);
      body.replaceWith(newBody);
    } catch (e) {
      wrap.lastChild.replaceWith(h('div', { class: 'error-box' }, e.message));
    }
  })();
  return wrap;
}

/**
 * Inventory matches block — fetches api_inventory_match(leadId) and renders
 * up to 8 ranked suggestions inline on the lead detail. Each card shows
 * the item, price, type and a "Recommend" button that adds a remark
 * "📦 Recommended <name>" so the team sees what was suggested.
 *
 * The match algorithm filters by status=available, lead.budget_max
 * (with 10% headroom) and lead.requirement_type. Blank inputs = no
 * filter on that axis.
 */
function matchingInventoryBlock(leadId) {
  const wrap = h('div', { class: 'card', style: { marginTop: '1rem', padding: '1rem' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.5rem' } },
      h('h4', { style: { margin: 0, flex: 1 } }, '📦 Matching inventory'),
      h('span', { class: 'muted', style: { fontSize: '.78rem' } }, 'Auto-suggested based on budget + requirement type')
    ),
    h('div', { class: 'muted' }, 'Loading…')
  );
  (async () => {
    try {
      const matches = await api('api_inventory_match', leadId);
      const body = wrap.lastChild;
      if (!matches.length) {
        body.replaceWith(h('p', { class: 'muted', style: { margin: 0 } },
          'No matching inventory yet. Add items under 📦 Inventory or set a budget / requirement type on this lead.'));
        return;
      }
      const grid = h('div', { class: 'cards', style: { gap: '.5rem', marginTop: '.25rem' } });
      matches.forEach(m => {
        grid.appendChild(h('div', {
          class: 'card', style: { padding: '.75rem', border: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: '.35rem' }
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', justifyContent: 'space-between' } },
            h('strong', {}, m.name),
            h('span', { class: 'tag', style: { background: '#dcfce7', color: '#166534' } }, '★ ' + m.score)
          ),
          h('div', { style: { fontSize: '.95rem' } }, '₹ ' + Number(m.price).toLocaleString('en-IN')),
          m.item_type ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, '📁 ' + m.item_type) : null,
          m.location ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, '📍 ' + m.location) : null,
          h('button', { class: 'btn sm primary', onclick: async () => {
            try {
              await api('api_leads_addRemark', leadId, {
                remark: '📦 Recommended ' + m.name +
                        ' · ₹' + Number(m.price).toLocaleString('en-IN') +
                        (m.item_type ? ' · ' + m.item_type : '') +
                        (m.location ? ' · ' + m.location : '')
              });
              toast('Recommendation logged on lead');
            } catch (e) { toast(e.message, 'err'); }
          } }, '+ Recommend')
        ));
      });
      body.replaceWith(grid);
    } catch (e) {
      wrap.lastChild.replaceWith(h('div', { class: 'error-box' }, e.message));
    }
  })();
  return wrap;
}

function actionTimelineBlock(leadId) {
  const wrap = h('div', { class: 'timeline-block' },
    h('div', { class: 'timeline-head' },
      h('h4', {}, '📋 Activity timeline'),
      h('span', { class: 'muted', style: { fontSize: '.78rem' } }, 'Every action on this lead — newest first')
    ),
    h('div', { class: 'muted' }, 'Loading…')
  );
  api('api_lead_actions', leadId).then(rows => {
    wrap.innerHTML = '';
    wrap.appendChild(h('div', { class: 'timeline-head' },
      h('h4', {}, '📋 Activity timeline'),
      h('span', { class: 'muted', style: { fontSize: '.78rem' } }, (rows?.length || 0) + ' events · newest first')
    ));
    if (!rows || rows.length === 0) {
      wrap.appendChild(h('p', { class: 'muted' }, 'No activity logged yet for this lead.'));
      return;
    }
    const created = rows[0]?.created_at;
    const fmtAge = (when) => {
      if (!created || !when) return '';
      const diffMs = new Date(when).getTime() - new Date(created).getTime();
      if (diffMs < 60_000) return Math.round(diffMs / 1000) + ' sec';
      if (diffMs < 3_600_000) return Math.round(diffMs / 60_000) + ' min';
      if (diffMs < 86_400_000) return (diffMs / 3_600_000).toFixed(1) + ' hr';
      return (diffMs / 86_400_000).toFixed(1) + ' days';
    };
    // Visual config per action type — icon + label + chip color so the
    // timeline reads at a glance.
    const cfg = {
      created:        { icon: '🎯', label: 'Lead received',        color: '#3b82f6' },
      status_change:  { icon: '🔄', label: 'Status changed',       color: '#8b5cf6' },
      remark:         { icon: '💬', label: 'Remark added',         color: '#06b6d4' },
      note_updated:   { icon: '📝', label: 'Notes updated',        color: '#06b6d4' },
      tags_updated:   { icon: '🏷️', label: 'Tags updated',         color: '#06b6d4' },
      followup_set:   { icon: '⏰', label: 'Follow-up scheduled',  color: '#f59e0b' },
      assigned:       { icon: '👤', label: 'Reassigned',           color: '#64748b' },
      call:           { icon: '📞', label: 'Call',                 color: '#ec4899' },
      whatsapp_out:   { icon: '📤', label: 'WhatsApp sent',        color: '#25d366' },
      whatsapp_in:    { icon: '📥', label: 'WhatsApp received',    color: '#10b981' },
      qualified:      { icon: '⭐', label: 'Marked qualified',     color: '#10b981' },
      unqualified:    { icon: '✕',  label: 'Unmarked qualified',   color: '#ef4444' },
      duplicated:     { icon: '📋', label: 'Duplicated',           color: '#64748b' },
      email_out:      { icon: '📧', label: 'Email sent',           color: '#3b82f6' }
    };

    // Render in REVERSE chronological order (newest first) — easier to skim
    // when checking "what was the last thing that happened?"
    const sorted = [...rows].reverse();
    const ul = h('ul', { class: 'timeline timeline-rich' });
    sorted.forEach(r => {
      const c = cfg[r.action_type] || { icon: '•', label: r.action_type, color: '#94a3b8' };
      const m = r.meta || {};
      // Compose a sub-line based on action type
      let sub = null;
      if (r.action_type === 'status_change') {
        sub = m.to_status_id || m.from_status_id ? ('Status #' + (m.from_status_id || '?') + ' → #' + (m.to_status_id || '?')) : null;
      } else if (r.action_type === 'remark') {
        sub = m.remark || null;
      } else if (r.action_type === 'followup_set') {
        sub = m.due_at ? ('Due ' + fmtDate(m.due_at)) : null;
      } else if (r.action_type === 'assigned') {
        sub = (m.from && m.to) ? ('User #' + m.from + ' → #' + m.to) : null;
      } else if (r.action_type === 'whatsapp_out') {
        sub = (m.template ? '[Template: ' + m.template + '] ' : '') + (m.preview || '');
        if (m.error) sub += ' ⚠ ' + m.error;
      } else if (r.action_type === 'whatsapp_in') {
        sub = m.preview || ('[' + (m.type || 'message') + ']');
      } else if (r.action_type === 'note_updated') {
        sub = m.preview || null;
      } else if (r.action_type === 'tags_updated') {
        sub = m.tags || null;
      }
      ul.appendChild(h('li', {},
        h('span', { class: 'tl-dot tl-dot-rich', style: { background: c.color } }, c.icon),
        h('div', { class: 'tl-body' },
          h('div', { class: 'tl-title' },
            h('b', {}, c.label),
            r.user_name ? h('span', { class: 'muted', style: { marginLeft: '.5rem', fontSize: '.78rem' } }, ' by ' + r.user_name) : null
          ),
          sub ? h('div', { class: 'tl-sub muted', style: { fontSize: '.85rem', marginTop: '.15rem' } }, String(sub).slice(0, 240) + (String(sub).length > 240 ? '…' : '')) : null,
          h('div', { class: 'tl-meta muted' },
            fmtDate(r.created_at, 'relative'),
            r.action_type !== 'created' ? ' · +' + fmtAge(r.created_at) + ' since received' : ''
          )
        )
      ));
    });
    wrap.appendChild(ul);
  }).catch(() => { wrap.style.display = 'none'; });
  return wrap;
}

function recordingsBlock(leadId) {
  const wrap = h('div', { class: 'recordings-block' }, h('h4', {}, '📼 Call recordings & AI Summary'));
  const list = h('ul', { class: 'rec-list' }, h('li', { class: 'muted' }, 'Loading…'));
  wrap.appendChild(list);
  api('api_leads_recordings', leadId).then(rows => {
    list.innerHTML = '';
    if (!rows || rows.length === 0) {
      list.appendChild(aiSummaryPlaceholder());
      return;
    }
    rows.forEach(r => list.appendChild(renderRecordingItem(r)));
  }).catch(e => {
    list.innerHTML = '';
    list.appendChild(h('li', { class: 'muted' }, 'Could not load: ' + e.message));
  });
  return wrap;
}

// Placeholder shown when a lead has no recordings yet — gives users a
// preview of what the AI Summary section will look like once a call is logged.
function aiSummaryPlaceholder() {
  return h('li', { class: 'rec-item rec-placeholder' },
    h('div', { class: 'placeholder-banner' },
      h('div', { class: 'placeholder-title' }, '🤖 AI Call Summary will appear here'),
      h('div', { class: 'placeholder-sub' },
        'Once a call is recorded for this lead, our AI automatically transcribes the conversation and shows the summary, sentiment, action items, suggested next status & a quality rating — all in this space.'
      )
    ),
    h('div', { class: 'ai-summary-card sample' },
      h('div', { class: 'ai-header' },
        h('span', { class: 'ai-badge' }, '🤖 AI Summary'),
        h('span', { class: 'ai-sentiment', style: 'color:#10b981' }, '😊 Positive'),
        h('span', { class: 'sample-tag' }, 'Sample preview')
      ),
      h('div', { class: 'ai-summary-text' },
        'Customer is interested in a 2BHK unit, budget around ₹85L. Discussed floor plans, payment schedule and possession timeline. Asked about home-loan tie-ups with HDFC.'
      ),
      h('div', { class: 'ai-insight' }, '💡 High-intent buyer — wants a site visit this weekend.'),
      h('div', { class: 'ai-actions' },
        h('div', { class: 'ai-actions-title' }, '✓ Action items'),
        h('div', { class: 'ai-action-item' }, '• Share 2BHK floor plan PDF on WhatsApp'),
        h('div', { class: 'ai-action-item' }, '• Confirm Saturday 11 AM site visit'),
        h('div', { class: 'ai-action-item' }, '• Send HDFC pre-approval form')
      ),
      h('div', { class: 'ai-apply-row' },
        h('span', { class: 'muted' }, '⭐ Suggested rating: 5/5  ·  ⏰ Follow up in 2 days  ·  🎯 Suggested status: Hot lead')
      )
    ),
    h('div', { class: 'placeholder-foot muted' },
      '↑ This is what you will see here after the first call is recorded. Upload a recording or call from the dialler to generate a real AI summary.'
    )
  );
}

function renderRecordingItem(r) {
  const dur = Number(r.duration_s) || 0;
  const mm = Math.floor(dur / 60), ss = (dur % 60).toString().padStart(2, '0');
  const dirIcon = r.direction === 'in' ? '📲' : r.direction === 'missed' ? '⚠️' : '📞';
  const audio = h('audio', {
    controls: true,
    preload: 'none',
    src: '/api/recordings/' + r.id + '/audio?token=' + encodeURIComponent(CRM.token || '')
  });
  const aiBlock = h('div', { class: 'rec-ai-block' });
  // Lazy-load the AI summary on first paint. Polls every 10s while pending.
  loadRecordingAI(r.id, aiBlock);
  return h('li', { class: 'rec-item' },
    h('div', { class: 'rec-meta' },
      h('span', { class: 'rec-dir' }, dirIcon),
      h('b', {}, r.lead_name || r.phone || '—'),
      h('span', { class: 'muted' }, ' · ' + fmtDate(r.created_at, 'relative') + ' · ' + mm + ':' + ss)
    ),
    audio,
    aiBlock
  );
}

/**
 * Fetch the AI summary for a recording and render it. If still pending,
 * poll every 10s. Renders summary + action items + sentiment chip +
 * "Apply suggested status" + "Schedule follow-up" buttons.
 */
/**
 * Build a 5-star rating widget. Filled to currentRating, hover changes
 * preview. Click to set. Shows AI-suggested rating as a faint hint star.
 */
function ratingStars(recId, currentRating, aiRating, onChange) {
  const wrap = h('div', { class: 'rating-stars' });
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    const s = h('span', { class: 'rating-star', 'data-val': i, role: 'button', tabindex: 0,
      title: 'Rate ' + i + (i === 1 ? ' star' : ' stars') }, '★');
    s.onclick = async () => {
      try {
        await api('api_recording_rate', recId, i, '');
        currentRating = i;
        paint();
        if (typeof onChange === 'function') onChange(i);
        toast('Rated ' + i + '/5');
      } catch (e) { toast(e.message, 'err'); }
    };
    s.onmouseenter = () => paintHover(i);
    s.onmouseleave = () => paint();
    stars.push(s);
    wrap.appendChild(s);
  }
  function paint() {
    stars.forEach((s, idx) => {
      const v = idx + 1;
      s.classList.toggle('filled', currentRating != null && v <= currentRating);
      s.classList.toggle('ai-hint', currentRating == null && aiRating != null && v <= aiRating);
    });
  }
  function paintHover(n) {
    stars.forEach((s, idx) => s.classList.toggle('filled', idx < n));
  }
  paint();
  if (currentRating != null) {
    const clear = h('button', { class: 'btn xs ghost rating-clear', title: 'Clear rating', onclick: async () => {
      try {
        await api('api_recording_rate', recId, null, '');
        currentRating = null;
        paint();
        toast('Rating cleared');
      } catch (e) { toast(e.message, 'err'); }
    } }, '✕');
    wrap.appendChild(clear);
  }
  if (aiRating != null) {
    const aiHint = h('span', { class: 'rating-ai-hint', title: 'AI suggested rating' },
      currentRating == null ? '🤖 ' + aiRating + '/5' : ''
    );
    if (currentRating == null) wrap.appendChild(aiHint);
  }
  return wrap;
}

async function loadRecordingAI(recId, container, retries) {
  retries = retries || 0;
  try {
    const r = await api('api_recording_aiSummary', recId);
    if (!r || r.status === 'pending') {
      if (retries === 0) {
        container.innerHTML = '';
        container.appendChild(h('div', { class: 'rating-row' },
          h('span', { class: 'rating-label' }, 'Rate this call:'),
          ratingStars(recId, null, null)
        ));
        const pending = h('div', { class: 'ai-pending' }, '🤖 AI is analysing this call…');
        container.appendChild(pending);
      }
      if (retries < 18) {
        setTimeout(() => loadRecordingAI(recId, container, retries + 1), 10000);
      } else {
        container.innerHTML = '';
        container.appendChild(h('div', { class: 'rating-row' },
          h('span', { class: 'rating-label' }, 'Rate this call:'),
          ratingStars(recId, null, null)
        ));
        container.appendChild(h('div', { class: 'ai-pending muted' }, '⏳ Still processing — refresh in a minute'));
      }
      return;
    }
    if (r.status === 'failed') {
      container.innerHTML = '';
      // Manual rating still works even when AI failed
      container.appendChild(h('div', { class: 'rating-row' },
        h('span', { class: 'rating-label' }, 'Rate this call:'),
        ratingStars(recId, r.rating, r.ai_suggested_rating)
      ));
      const isDisabled = /disabled by admin/i.test(r.error || '');
      if (!isDisabled) {
        container.appendChild(h('div', { class: 'ai-error' },
          '⚠️ AI summary failed: ' + (r.error || 'unknown') + ' ',
          h('button', { class: 'btn xs', onclick: () => window.retryAi(recId, null) }, 'Retry')
        ));
      }
      return;
    }
    // r.status === 'done'
    const sentColor = { positive: '#10b981', neutral: '#64748b', negative: '#ef4444' }[r.sentiment] || '#64748b';
    const sentLabel = { positive: '😊 Positive', neutral: '😐 Neutral', negative: '😟 Negative' }[r.sentiment] || r.sentiment || '—';
    container.innerHTML = '';
    // Manual call rating row — always shown, regardless of AI status
    container.appendChild(h('div', { class: 'rating-row' },
      h('span', { class: 'rating-label' }, 'Rate this call:'),
      ratingStars(recId, r.rating, r.ai_suggested_rating)
    ));
    container.appendChild(h('div', { class: 'ai-summary-card' },
      h('div', { class: 'ai-header' },
        h('span', { class: 'ai-badge' }, '🤖 AI Summary'),
        h('span', { class: 'ai-sentiment', style: 'color:' + sentColor }, sentLabel),
        h('button', { class: 'btn xs ghost', title: 'Re-analyse this call', onclick: () => {
          api('api_recording_aiReprocess', recId).then(() => loadRecordingAI(recId, container, 0));
        } }, '↻')
      ),
      h('div', { class: 'ai-summary-text' }, r.summary || '—'),
      r.key_insight ? h('div', { class: 'ai-insight' }, '💡 ' + r.key_insight) : null,
      r.action_items && r.action_items.length > 0
        ? h('div', { class: 'ai-actions' },
            h('div', { class: 'ai-actions-title' }, '✓ Action items'),
            ...r.action_items.map(a => h('div', { class: 'ai-action-item' }, '• ' + a))
          )
        : null,
      (r.suggested_status_id || r.next_followup_days != null)
        ? h('div', { class: 'ai-apply-row' },
            h('button', { class: 'btn sm primary', onclick: async () => {
              try {
                await api('api_recording_applySuggestion', recId, { applyStatus: true, applyFollowup: true });
                toast('✓ Status updated + follow-up scheduled');
                if (typeof loadLeads === 'function') loadLeads();
              } catch (e) { toast(e.message, 'err'); }
            } }, '✓ Apply suggestion'),
            r.next_followup_days != null
              ? h('span', { class: 'muted' }, '· schedule callback in ' + r.next_followup_days + ' day(s)')
              : null
          )
        : null,
      h('details', { class: 'ai-transcript' },
        h('summary', {}, '📝 Transcript'),
        h('pre', {}, r.transcript || 'No transcript')
      )
    ));
  } catch (e) {
    container.innerHTML = '<div class="ai-error muted">AI summary unavailable: ' + esc(e.message) + '</div>';
  }
}

window.retryAi = function(id, btn) {
  if (btn) btn.disabled = true;
  api('api_recording_aiReprocess', id).then(() => {
    const block = btn && btn.closest('.rec-ai-block');
    if (block) loadRecordingAI(id, block, 0);
  }).catch(e => toast(e.message, 'err'));
};

function remarksBlock(rs, leadId) {
  const list = h('ul', { class: 'remarks-list' });
  (rs || []).forEach(r => list.appendChild(h('li', {},
    h('b', {}, r.user_name || '—'), ' · ', fmtDate(r.created_at, 'relative'),
    h('br'), r.remark || ''
  )));
  const textarea = h('textarea', { placeholder: 'Add a remark…', rows: 2 });
  const btn = h('button', { type: 'button', class: 'btn sm', onclick: async () => {
    if (!textarea.value.trim()) return;
    try {
      await api('api_leads_addRemark', leadId, { remark: textarea.value });
      const r = await api('api_leads_get', leadId);
      list.innerHTML = '';
      (r.remarks || []).forEach(x => list.appendChild(h('li', {},
        h('b', {}, x.user_name || '—'), ' · ', fmtDate(x.created_at, 'relative'), h('br'), x.remark || ''
      )));
      textarea.value = '';
      toast('Remark added');
    } catch (e) { toast(e.message, 'err'); }
  } }, 'Add remark');
  return h('div', { class: 'remarks-block' },
    h('h4', {}, 'Remarks'), list, textarea, btn
  );
}

async function openRemarkInline(leadId) {
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('h3', {}, 'Add remark'),
    h('textarea', { id: 'inline-rmk', rows: 3, placeholder: 'Write remark…' }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const text = $('#inline-rmk').value.trim();
        if (!text) return;
        try { await api('api_leads_addRemark', leadId, { remark: text }); toast('Added'); modal.remove(); loadLeads(); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Save')
    )
  ));
  document.body.appendChild(modal);
  setTimeout(() => $('#inline-rmk').focus(), 50);
}

async function openDuplicateHistory(leadId) {
  try {
    const history = await api('api_leads_duplicateHistory', leadId);
    const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } },
      h('div', { class: 'modal modal-lg' },
        h('div', { class: 'modal-head' }, h('h3', {}, 'Duplicate history'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
        (!history || history.length === 0)
          ? h('p', { class: 'muted' }, 'No matching past leads found.')
          : h('div', {},
              ...history.map(l => h('div', { class: 'dup-item' },
                h('div', {}, h('b', {}, l.name || '—'), ' · ', l.phone || l.email || '', ' · ', fmtDate(l.created_at, 'relative')),
                h('div', { class: 'muted' }, 'Status: ' + (l.status_name || '—') + ' · Assigned: ' + (l.assigned_name || '—')),
                ...(l.remarks || []).map(r => h('div', { class: 'dup-remark' }, '💬 ', r.remark, ' — ', fmtDate(r.created_at, 'short')))
              ))
            )
      )
    );
    document.body.appendChild(modal);
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- Dialer (TeleCRM-style) ---------------- */
let _dialerState = null;

VIEWS.dialer = async (view) => {
  // Tab state: 'pad' (dialpad) | 'history' (call log) | 'recordings' (audio list)
  _dialerState = { tab: 'pad', digits: '', view };

  view.innerHTML = '';

  // Always-visible banner when running on the APK and no folder is connected
  // yet. Impossible to miss, taps directly into the picker. Hidden as soon
  // as the user picks a folder (next render won't include it).
  const isApkRuntime = !!(window.LeadCRMNative && typeof LeadCRMNative.getRecordingFolder === 'function');
  let connectedFolder = '';
  try { connectedFolder = isApkRuntime ? (LeadCRMNative.getRecordingFolder() || '') : ''; } catch (_) {}
  if (isApkRuntime && !connectedFolder) {
    view.appendChild(h('div', {
      style: { background: '#fef3c7', color: '#92400e', borderLeft: '4px solid #f59e0b', padding: '.7rem 1rem', borderRadius: '8px', marginBottom: '.75rem', cursor: 'pointer' },
      onclick: () => setupRecordingFolder()
    },
      h('b', {}, '📁 Connect call recordings folder '),
      h('span', { class: 'muted' }, '— tap here to pick the folder where your phone saves call recordings. Without this, calls won\'t auto-attach to leads.')
    ));
  }

  const tabs = h('div', { class: 'dialer-tabs' },
    tabBtn('pad', '📟 Dialpad'),
    tabBtn('history', '🕒 History'),
    tabBtn('recordings', '📼 Recordings'),
    tabBtn('settings', '⚙️')
  );
  const body = h('div', { class: 'dialer-body' });
  view.appendChild(h('div', { class: 'dialer-shell' }, tabs, body));

  function tabBtn(id, label) {
    return h('button', {
      class: 'dialer-tab' + (_dialerState.tab === id ? ' active' : ''),
      onclick: () => { _dialerState.tab = id; renderDialerTab(); }
    }, label);
  }

  function renderDialerTab() {
    [...tabs.children].forEach((c, i) => {
      const ids = ['pad', 'history', 'recordings', 'settings'];
      c.classList.toggle('active', _dialerState.tab === ids[i]);
    });
    body.innerHTML = '';
    if (_dialerState.tab === 'pad') body.appendChild(renderDialpad());
    else if (_dialerState.tab === 'history') body.appendChild(renderHistory());
    else if (_dialerState.tab === 'recordings') body.appendChild(renderRecordingsList());
    else body.appendChild(renderDialerSettings());
  }

  renderDialerTab();

  // Dialer-tab nudge: if the user lands on the Dialer page and still hasn't
  // picked a folder (e.g. they dismissed the boot-time onboarding modal),
  // open the picker once per session. The boot onboarding (firstRunRecordingPrompt)
  // is the primary path; this is a backup so users who hit Dialer before
  // dismissing/seeing onboarding still get prompted.
  if (window.LeadCRMNative && typeof LeadCRMNative.getRecordingFolder === 'function') {
    try {
      const fld = LeadCRMNative.getRecordingFolder();
      if (!fld
          && !sessionStorage.getItem('rec_setup_dismissed')
          && localStorage.getItem('rec_onboarding_seen_v2') !== '1') {
        setTimeout(() => {
          if (location.hash === '#/dialer') setupRecordingFolder();
          sessionStorage.setItem('rec_setup_dismissed', '1');
        }, 800);
      }
    } catch (_) {}
  }
};

function renderDialerSettings() {
  const wrap = h('div', { class: 'dialer-settings' });
  const isApp = !!(window.LeadCRMNative && typeof LeadCRMNative.getRecordingFolder === 'function');
  let folder = '';
  try { folder = isApp ? (LeadCRMNative.getRecordingFolder() || '') : ''; } catch (_) {}
  const lastSync = Number(localStorage.getItem('rec_last_sync') || 0);

  if (!isApp) {
    wrap.appendChild(h('div', { class: 'settings-card' },
      h('h4', {}, '📱 Open in the Android app'),
      h('p', { class: 'muted' }, 'Recording sync only works inside the LeadCRM Android app — install it from the Install page.')
    ));
    return wrap;
  }

  // Folder card
  wrap.appendChild(h('div', { class: 'settings-card' },
    h('h4', {}, '📁 Call recordings folder'),
    folder
      ? h('div', {},
          h('div', { class: 'rec-folder-current' }, h('code', {}, folder)),
          h('div', { class: 'muted' }, 'The app reads new files from this folder, parses the phone number, and uploads each recording to the matching lead.'),
          h('div', { class: 'actions' },
            h('button', { class: 'btn primary', onclick: () => syncRecordings() }, '🔄 Sync now'),
            h('button', { class: 'btn', onclick: () => syncRecordings({ full: true }) }, '⚡ Re-sync all'),
            h('button', { class: 'btn ghost', onclick: () => { setupRecordingFolder(); } }, 'Change folder'),
            h('button', { class: 'btn ghost', onclick: () => { if (confirm('Forget folder + clear sync history?')) resetRecordingFolder(); } }, 'Reset')
          ),
          h('div', { class: 'muted', style: { marginTop: '.5rem', fontSize: '.78rem' } },
            h('span', { id: 'sync-progress', style: { fontWeight: 600 } }, ''),
            ' · Last synced: ', lastSync ? fmtDate(new Date(lastSync).toISOString(), 'relative') : 'never'
          )
        )
      : h('div', {},
          h('p', { class: 'muted' }, 'No folder connected yet. Pick the folder where your phone saves call recordings.'),
          h('button', { class: 'btn primary', onclick: () => setupRecordingFolder() }, '📁 Pick recordings folder')
        )
  ));

  // Filter card
  const includeUnmatched = localStorage.getItem('rec_include_unmatched') === '1';
  wrap.appendChild(h('div', { class: 'settings-card' },
    h('h4', {}, '🎯 Sync filter'),
    h('p', { class: 'muted' },
      'By default the app only uploads recordings whose phone number matches a lead in your CRM. ' +
      'Personal calls (family, courier, OTP) are skipped.'),
    h('label', { class: 'toggle-row' },
      h('input', {
        type: 'checkbox',
        checked: includeUnmatched ? 'checked' : null,
        onchange: ev => {
          localStorage.setItem('rec_include_unmatched', ev.target.checked ? '1' : '0');
          toast(ev.target.checked ? 'Will upload all recordings' : 'Lead-only filter active');
        }
      }),
      h('span', {}, 'Include unmatched recordings (upload everything)')
    )
  ));

  // Help card
  wrap.appendChild(h('div', { class: 'settings-card' },
    h('h4', {}, 'ℹ️ How it works'),
    h('ol', { class: 'how-it-works' },
      h('li', {}, 'Enable call recording in your phone\'s dialer (Settings → Phone → Call recording).'),
      h('li', {}, 'Make a call. The phone saves an audio file (e.g. ', h('code', {}, '+91XXXX_2024-04-25.m4a'), ') to its recordings folder.'),
      h('li', {}, 'Open this app and tap ', h('b', {}, 'Sync now'), '. The CRM finds each new file, reads the phone number from the filename, looks up the matching lead, and uploads the recording.'),
      h('li', {}, 'Listen to recordings inside any lead\'s detail page or under ', h('b', {}, 'Recordings'), '.')
    ),
    h('p', { class: 'muted' }, 'Note: the CRM does not record calls itself — that complies with Indian and EU regulations. You (or your phone\'s built-in recorder) control recording.')
  ));

  return wrap;
}

function renderDialpad() {
  const wrap = h('div', { class: 'dialpad-wrap' });

  // Number display + lead-match dropdown
  const display = h('input', {
    type: 'tel',
    class: 'dialpad-display',
    placeholder: 'Enter number or name…',
    value: _dialerState.digits,
    oninput: ev => { _dialerState.digits = ev.target.value; debouncedRenderMatches(); }
  });
  const matches = h('div', { class: 'dialpad-matches' });

  // Debounce so we don't re-filter the lead list on every keystroke
  let _matchTimer = null;
  function debouncedRenderMatches() {
    if (_matchTimer) clearTimeout(_matchTimer);
    _matchTimer = setTimeout(renderMatches, 80);
  }

  function renderMatches() {
    matches.innerHTML = '';
    const q = _dialerState.digits.trim();
    if (!q) return;
    const isDigits = /^[\d+\-\s]+$/.test(q);
    const ql = q.toLowerCase();
    const found = (CRM.cache.lastLeads || []).filter(l => {
      if (isDigits) {
        const d = String(l.phone || '').replace(/\D/g, '');
        return d.includes(q.replace(/\D/g, ''));
      }
      return String(l.name || '').toLowerCase().includes(ql);
    }).slice(0, 6);
    found.forEach(l => matches.appendChild(h('button', {
      class: 'dialpad-match',
      onclick: () => {
        display.value = l.phone || '';
        _dialerState.digits = l.phone || '';
        callLead(l);
      }
    },
      h('div', {}, h('b', {}, l.name || '—')),
      h('div', { class: 'muted' }, l.phone || '')
    )));
    // If no match and digits look like a phone, offer "Save & Call"
    if (found.length === 0 && isDigits && q.replace(/\D/g, '').length >= 6) {
      matches.appendChild(h('button', {
        class: 'dialpad-match new',
        onclick: () => {
          openLeadModal();
          setTimeout(() => {
            const f = $('#lead-form');
            if (f && f.phone) f.phone.value = q;
          }, 150);
        }
      }, '+ Save "' + q + '" as new lead'));
    }
  }

  // Dialpad keys
  const keys = [
    ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
    ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
    ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
    ['*', ''], ['0', '+'], ['#', '']
  ];
  const grid = h('div', { class: 'dialpad-grid' },
    ...keys.map(([d, sub]) => h('button', {
      class: 'dialpad-key',
      onclick: () => {
        // Long-press on 0 = "+"
        if (d === '0' && _dialerLongPress0) {
          _dialerState.digits += '+';
        } else {
          _dialerState.digits += d;
        }
        display.value = _dialerState.digits;
        debouncedRenderMatches();
      },
      onmousedown: () => { if (d === '0') _dialerLongPress0Timer = setTimeout(() => { _dialerLongPress0 = true; }, 600); },
      onmouseup: () => { clearTimeout(_dialerLongPress0Timer); setTimeout(() => { _dialerLongPress0 = false; }, 50); },
      ontouchstart: () => { if (d === '0') _dialerLongPress0Timer = setTimeout(() => { _dialerLongPress0 = true; }, 600); },
      ontouchend: () => { clearTimeout(_dialerLongPress0Timer); setTimeout(() => { _dialerLongPress0 = false; }, 50); }
    },
      h('span', { class: 'dialpad-d' }, d),
      sub ? h('span', { class: 'dialpad-sub' }, sub) : null
    ))
  );

  const callBtn = h('button', {
    class: 'dialpad-call',
    onclick: () => {
      const raw = _dialerState.digits.trim();
      if (!raw) return toast('Type a number first', 'warn');
      const digits = raw.replace(/\D/g, '');
      // Look up matching lead
      const lead = (CRM.cache.lastLeads || []).find(l =>
        digits && String(l.phone || '').replace(/\D/g, '').endsWith(digits.slice(-10))
      ) || { id: null, name: '', phone: raw };
      callLead(lead);
    }
  }, '📞');

  const back = h('button', {
    class: 'dialpad-back',
    onclick: () => {
      _dialerState.digits = _dialerState.digits.slice(0, -1);
      display.value = _dialerState.digits;
    }
  }, '⌫');

  wrap.appendChild(display);
  wrap.appendChild(matches);
  wrap.appendChild(grid);
  wrap.appendChild(h('div', { class: 'dialpad-actions' }, back, callBtn));
  return wrap;
}
let _dialerLongPress0 = false;
let _dialerLongPress0Timer = null;

function renderHistory() {
  const wrap = h('div', { class: 'dialer-history' }, h('div', { class: 'muted' }, 'Loading call history…'));
  api('api_call_history', 100).then(rows => {
    wrap.innerHTML = '';
    if (!rows || rows.length === 0) {
      wrap.appendChild(h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, 'No calls yet.'));
      return;
    }
    rows.forEach(r => wrap.appendChild(renderHistoryItem(r)));
  }).catch(e => {
    wrap.innerHTML = '';
    wrap.appendChild(h('div', { class: 'muted' }, 'Could not load: ' + e.message));
  });
  return wrap;
}

function renderHistoryItem(r) {
  const dur = Number(r.duration_s || r.rec_duration) || 0;
  const mm = Math.floor(dur / 60), ss = (dur % 60).toString().padStart(2, '0');
  const dirIcon = r.direction === 'in' ? '📲' :
                  r.event === 'recording_saved' ? '📼' :
                  r.event === 'call_ended' ? '✅' :
                  r.event === 'incoming_ringing' ? '📲' : '📞';
  const item = h('div', { class: 'hist-item' },
    h('div', { class: 'hist-row' },
      h('span', { class: 'hist-icon' }, dirIcon),
      h('div', { class: 'hist-meta' },
        h('div', {}, h('b', {}, r.lead_name || r.phone || 'Unknown')),
        h('div', { class: 'muted' }, (r.lead_name ? r.phone + ' · ' : '') + fmtDate(r.created_at, 'relative') + (dur ? ' · ' + mm + ':' + ss : ''))
      ),
      r.phone ? h('button', {
        class: 'btn icon hist-redial',
        onclick: () => {
          const lead = (CRM.cache.lastLeads || []).find(l =>
            String(l.phone || '').replace(/\D/g, '').endsWith(String(r.phone).replace(/\D/g, '').slice(-10))
          ) || { name: r.lead_name || '', phone: r.phone };
          callLead(lead);
        }
      }, '📞') : null,
      r.lead_id ? h('button', {
        class: 'btn icon',
        title: 'Open lead',
        onclick: () => openLeadModal(r.lead_id)
      }, '📂') : null
    )
  );
  // Inline audio player if there's a recording attached
  if (r.recording_id || r.rec_id) {
    const recId = r.recording_id || r.rec_id;
    item.appendChild(h('audio', {
      controls: true, preload: 'none',
      class: 'hist-audio',
      src: '/api/recordings/' + recId + '/audio?token=' + encodeURIComponent(CRM.token || '')
    }));
  }
  return item;
}

function renderRecordingsList() {
  const wrap = h('div', { class: 'dialer-history' }, h('div', { class: 'muted' }, 'Loading recordings…'));
  api('api_my_recordings', 200).then(rows => {
    wrap.innerHTML = '';
    if (!rows || rows.length === 0) {
      wrap.appendChild(h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, 'No recordings yet.'));
      return;
    }
    rows.forEach(r => wrap.appendChild(renderRecordingItem(r)));
  }).catch(e => {
    wrap.innerHTML = '';
    wrap.appendChild(h('div', { class: 'muted' }, 'Could not load: ' + e.message));
  });
  return wrap;
}

function refreshDialerHistory() {
  if (!_dialerState || !_dialerState.view) return;
  if (location.hash !== '#/dialer') return;
  // NEVER re-render the whole dialer — that nukes the dialpad input focus
  // and the digits the user is typing. Only refresh the History/Recordings
  // tabs (those don't have user inputs).
  if (_dialerState.tab === 'history') {
    const body = _dialerState.view.querySelector('.dialer-body');
    if (body && typeof renderHistory === 'function') {
      body.innerHTML = '';
      body.appendChild(renderHistory());
    }
  } else if (_dialerState.tab === 'recordings') {
    const body = _dialerState.view.querySelector('.dialer-body');
    if (body && typeof renderRecordingsList === 'function') {
      body.innerHTML = '';
      body.appendChild(renderRecordingsList());
    }
  }
  // Dialpad / Settings tabs intentionally NOT auto-refreshed.
}

/* ---------------- Pipeline ---------------- */
VIEWS.pipeline = async (view) => {
  const [funnel, summary, pipeline] = await Promise.all([
    api('api_reports_funnel', {}),
    api('api_reports_summary', {}),
    api('api_leads_pipeline')
  ]);
  const total = summary.totals.total || 1;
  view.innerHTML = '';

  // Funnel summary card — waterfall view: biggest stage on top,
  // narrower as we go down. Hides empty stages so the visual stays clean.
  // Sort by count DESC and use the top stage as the conversion baseline.
  const funnelSorted = [...funnel]
    .map(s => ({ ...s, _c: Number(s.count) || 0 }))
    .filter(s => s._c > 0)
    .sort((a, b) => b._c - a._c);
  const topCount = funnelSorted[0]?._c || total;
  view.appendChild(h('div', { class: 'card' },
    h('h3', {}, 'Sales funnel'),
    h('div', { class: 'funnel' },
      ...funnelSorted.map((s, i) => {
        const pct = Math.round((s._c / total) * 100);
        const width = topCount > 0 ? Math.max(20, Math.round((s._c / topCount) * 100)) : 20;
        const prev = i > 0 ? funnelSorted[i - 1]._c : topCount;
        const conv = prev > 0 ? Math.round((s._c / prev) * 100) : 0;
        return h('div', { class: 'funnel-row' },
          h('div', { class: 'funnel-label' }, s.name),
          h('div', { class: 'funnel-bar-wrap' },
            h('div', { class: 'funnel-bar', style: { width: width + '%', background: s.color } },
              h('span', { class: 'funnel-count' }, s._c),
              h('span', { class: 'funnel-pct' }, pct + '%')
            )
          ),
          h('div', { class: 'funnel-conv' }, i === 0 ? '—' : conv + '% vs prev')
        );
      })
    )
  ));

  // Leads per stage (expandable sections) — also rendered in waterfall
  // order so the biggest bucket is at the top, matching the funnel above.
  // Includes empty stages too so the user can still see them and add
  // leads if needed.
  view.appendChild(h('h3', { style: { marginTop: '1.25rem' } }, 'Leads by stage'));
  const wrap = h('div', { class: 'pipeline-stages' });
  view.appendChild(wrap);

  const funnelByCount = [...funnel]
    .map(s => ({ ...s, _c: Number(s.count) || 0 }))
    .sort((a, b) => b._c - a._c);
  funnelByCount.forEach(s => {
    const entry = pipeline.find(p => Number(p.id) === Number(s.id));
    const leads = entry?.leads || [];
    const details = h('details', { class: 'pipeline-stage-card', style: { borderTopColor: s.color } },
      h('summary', {},
        h('span', { class: 'ps-dot', style: { background: s.color } }),
        h('span', { class: 'ps-name' }, s.name),
        h('span', { class: 'ps-count' }, leads.length),
        h('span', { class: 'ps-hint muted' }, leads.length > 0 ? 'click to expand' : 'no leads')
      ),
      leads.length > 0
        ? h('div', { class: 'ps-body' },
            h('table', { class: 'mini-table' },
              h('thead', {}, h('tr', {},
                h('th', {}, 'Name'), h('th', {}, 'Phone'),
                h('th', {}, 'Source'), h('th', {}, 'Assignee'),
                h('th', {}, 'Follow-up'), h('th', {})
              )),
              h('tbody', {}, ...leads.map(l => h('tr', {},
                h('td', {}, h('a', { href: '#', onclick: ev => { ev.preventDefault(); openLeadModal(l.id); } }, l.name || '—')),
                h('td', {},
                  l.phone || '',
                  l.phone ? h('button', { class: 'btn icon', title: 'Copy', onclick: () => { navigator.clipboard.writeText(l.phone); toast('Copied'); } }, '📋') : null,
                  l.phone ? h('a', { class: 'btn icon', href: `https://wa.me/${String(l.phone).replace(/\D/g,'')}`, target: '_blank', title: 'WhatsApp' }, '💬') : null
                ),
                h('td', {}, l.source || ''),
                h('td', {}, l.assigned_name || '—'),
                h('td', { class: l.next_followup_at && new Date(l.next_followup_at) < new Date() ? 'overdue' : '' },
                  l.next_followup_at ? fmtDate(l.next_followup_at, 'relative') : '—'),
                h('td', {}, h('button', { class: 'btn sm', onclick: () => openLeadModal(l.id) }, '✎'))
              )))
            )
          )
        : null
    );
    // Auto-expand first non-empty stage
    if (leads.length > 0 && !wrap.querySelector('details[open]')) details.open = true;
    wrap.appendChild(details);
  });
};

/* ---------------- Kanban (drag & drop, stable handlers) ----------------
 * Design notes:
 *  - Cards mirror the leads-list row content (name, phone, value, tags,
 *    qualified ★, assignee, FU chip) so reps don't lose info when they
 *    flip from list to board.
 *  - Same filter set as the leads list (search, assignee, source,
 *    qualified). Persisted to localStorage as `crm_kanban_filters` so
 *    the rep's morning view stays put.
 *  - Click a column header to collapse it to a thin strip — useful for
 *    Lost / Junk which don't need to occupy 250px of board real estate.
 *    Collapsed columns persist via `crm_kanban_collapsed`.
 */

function _kbFollowupChip(iso) {
  if (!iso) return null;
  const due = new Date(iso).getTime();
  if (isNaN(due)) return null;
  const now = Date.now();
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const isOverdue = due < now;
  const isToday   = !isOverdue && due <= today.getTime();
  const cls = isOverdue ? 'kc-fu overdue' : isToday ? 'kc-fu today' : 'kc-fu future';
  return h('span', { class: cls }, '⏰ ' + fmtDate(iso, 'relative'));
}

function _kbInr(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(n % 10000000 === 0 ? 0 : 2) + ' Cr';
  if (n >= 100000)   return '₹' + (n / 100000).toFixed(n % 100000 === 0 ? 0 : 2) + ' L';
  if (n >= 1000)     return '₹' + (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return '₹' + n.toFixed(0);
}

function _kbInitials(name) {
  return String(name || '?').split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function _kbMatchesFilters(l, f) {
  if (f.q) {
    const q = String(f.q).toLowerCase();
    const hit =
      String(l.name || '').toLowerCase().includes(q) ||
      String(l.phone || '').toLowerCase().includes(q) ||
      String(l.email || '').toLowerCase().includes(q) ||
      String(l.whatsapp || '').toLowerCase().includes(q);
    if (!hit) return false;
  }
  if (f.assigned_to && Number(l.assigned_to) !== Number(f.assigned_to)) return false;
  if (f.source && l.source !== f.source) return false;
  if (f.qualified === '1' && Number(l.qualified) !== 1) return false;
  if (f.qualified === '0' && Number(l.qualified) === 1) return false;
  return true;
}

VIEWS.kanban = async (view) => {
  if (!CRM.cache.statuses) await warmCache();
  const statuses = CRM.cache.statuses;
  const sources  = CRM.cache.sources  || [];
  const users    = CRM.cache.users    || [];
  const kanban   = await api('api_leads_pipeline');
  const filters  = JSON.parse(localStorage.getItem('crm_kanban_filters') || '{}');
  const collapsed = JSON.parse(localStorage.getItem('crm_kanban_collapsed') || '[]');
  view.innerHTML = '';

  const persistFilters = () => localStorage.setItem('crm_kanban_filters', JSON.stringify(filters));
  const persistCollapsed = () => localStorage.setItem('crm_kanban_collapsed', JSON.stringify(collapsed));

  // ---- Toolbar (mirrors the leads-list filter set) ---------------------
  const search = h('input', {
    id: 'kb-q', class: 'flex',
    placeholder: 'Search name / phone / email…',
    value: filters.q || ''
  });
  let searchTimer;
  search.addEventListener('input', () => {
    filters.q = search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { persistFilters(); render(); }, 200);
  });

  const assigneeSel = selectOpts('kb-assigned',
    [{ id: '', name: 'Any assignee' }, ...users],
    filters.assigned_to);
  assigneeSel.addEventListener('change', () => { filters.assigned_to = assigneeSel.value || ''; persistFilters(); render(); });

  const sourceSel = selectOpts('kb-source',
    [{ id: '', name: 'Any source' }, ...sources.map(s => ({ id: s.name, name: s.name }))],
    filters.source);
  sourceSel.addEventListener('change', () => { filters.source = sourceSel.value || ''; persistFilters(); render(); });

  const qualifiedSel = selectOpts('kb-qualified',
    [{ id: '', name: 'Any qualified' }, { id: '1', name: '⭐ Qualified only' }, { id: '0', name: 'Not qualified' }],
    filters.qualified);
  qualifiedSel.addEventListener('change', () => { filters.qualified = qualifiedSel.value || ''; persistFilters(); render(); });

  const clearBtn = h('button', {
    class: 'btn ghost', title: 'Reset filters',
    onclick: () => {
      ['q', 'assigned_to', 'source', 'qualified'].forEach(k => delete filters[k]);
      persistFilters();
      navigateTo('kanban');
    }
  }, '✕');

  view.appendChild(h('div', { class: 'toolbar' },
    search, assigneeSel, sourceSel, qualifiedSel, clearBtn,
    h('button', { class: 'btn primary', onclick: () => openLeadModal() }, '+ New Lead')
  ));

  const wrap = h('div', { class: 'kanban' });
  view.appendChild(wrap);

  function render() {
    wrap.innerHTML = '';
    statuses.forEach(s => {
      const col = h('div', { class: 'kanban-col' });
      col.dataset.statusId = s.id;
      const isCollapsed = collapsed.includes(Number(s.id));
      if (isCollapsed) col.classList.add('kanban-col-collapsed');

      // ---- Drag-and-drop handlers (drop changes status) -----------------
      col.addEventListener('dragover', ev => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        col.classList.add('drop-hover');
      });
      col.addEventListener('dragleave', () => col.classList.remove('drop-hover'));
      col.addEventListener('drop', async ev => {
        ev.preventDefault();
        ev.stopPropagation();
        col.classList.remove('drop-hover');
        const leadId = Number(ev.dataTransfer.getData('text/plain') || ev.dataTransfer.getData('application/lead-id'));
        if (!leadId) return;
        const newStatusId = Number(col.dataset.statusId);
        try {
          await api('api_leads_update', leadId, { status_id: newStatusId });
          toast('Status updated');
          render();
        } catch (e) { toast(e.message, 'err'); }
      });

      // Filter the leads for this column.
      const allLeads = kanban.find(k => Number(k.id) === Number(s.id))?.leads || [];
      const visible  = allLeads.filter(l => _kbMatchesFilters(l, filters));
      const valueSum = visible.reduce((sum, l) => sum + (Number(l.value) || 0), 0);

      // ---- Column header — click to collapse/expand --------------------
      const head = h('h4', {
        class: 'kanban-head',
        style: { borderTopColor: s.color },
        onclick: () => {
          const idx = collapsed.indexOf(Number(s.id));
          if (idx >= 0) collapsed.splice(idx, 1); else collapsed.push(Number(s.id));
          persistCollapsed();
          render();
        }
      },
        h('span', { class: 'kanban-name' }, s.name),
        h('span', { class: 'kanban-meta' },
          visible.length + (valueSum > 0 ? ' · ' + _kbInr(valueSum) : '')
        )
      );
      col.appendChild(head);

      if (!isCollapsed) {
        visible.forEach(l => {
          const card = h('div', { class: 'kanban-card', draggable: 'true' });
          card.dataset.leadId = l.id;
          card.addEventListener('dragstart', ev => {
            ev.dataTransfer.setData('text/plain', String(l.id));
            ev.dataTransfer.setData('application/lead-id', String(l.id));
            ev.dataTransfer.effectAllowed = 'move';
            card.classList.add('dragging');
          });
          card.addEventListener('dragend', () => card.classList.remove('dragging'));
          card.addEventListener('click', () => {
            if (!card.classList.contains('was-dragged')) openLeadModal(l.id);
          });

          // Top row: name + qualified ★
          const topRow = h('div', { class: 'kc-top' },
            h('div', { class: 'kc-name' }, l.name || '—'),
            Number(l.qualified) === 1 ? h('span', { class: 'kc-star', title: 'Qualified' }, '★') : null
          );
          card.appendChild(topRow);

          // Phone + source
          const meta = (l.phone || '') + (l.source ? ' · ' + l.source : '');
          if (meta) card.appendChild(h('div', { class: 'kc-meta' }, meta));

          // Value (large, prominent)
          const valStr = _kbInr(l.value);
          if (valStr) card.appendChild(h('div', { class: 'kc-value' }, valStr));

          // Tags (chips, max 3 visible)
          const tags = String(l.tags || '').split(',').map(t => t.trim()).filter(Boolean);
          if (tags.length) {
            const tagWrap = h('div', { class: 'kc-tags' });
            tags.slice(0, 3).forEach(t => tagWrap.appendChild(h('span', { class: 'kc-tag' }, t)));
            if (tags.length > 3) tagWrap.appendChild(h('span', { class: 'kc-tag muted' }, '+' + (tags.length - 3)));
            card.appendChild(tagWrap);
          }

          // Footer: assignee | follow-up chip
          const repName = l.assigned_name || '—';
          const initials = _kbInitials(repName);
          card.appendChild(h('div', { class: 'kc-foot' },
            h('span', { class: 'kc-rep', title: repName },
              h('span', { class: 'kc-avatar' }, initials),
              h('span', { class: 'kc-rep-name' }, repName)
            ),
            _kbFollowupChip(l.next_followup_at)
          ));

          col.appendChild(card);
        });

        if (allLeads.length > visible.length) {
          col.appendChild(h('div', { class: 'kanban-filtered-note' },
            (allLeads.length - visible.length) + ' filtered out'));
        }
      }

      wrap.appendChild(col);
    });
  }

  render();
};

/* ---------------- Follow-ups ---------------- */
// Sidebar shortcut views — each one is a single-section variant of
// the Followups view, so users with overdue/due-today work can land
// directly on the right list from the sidebar.
VIEWS.overdue  = async (view) => renderFollowupSection(view, 'overdue');
VIEWS.duetoday = async (view) => renderFollowupSection(view, 'due_today');
VIEWS.upcoming = async (view) => renderFollowupSection(view, 'upcoming');
VIEWS.newleads = async (view) => renderNewTodayLeads(view);

async function renderFollowupSection(view, key) {
  const data = await api('api_notifications_mine');
  view.innerHTML = '';
  const titleMap = { overdue: '⚠️ Overdue follow-ups', due_today: '📅 Due today', upcoming: '⏰ Upcoming' };
  const klassMap = { overdue: 'err', due_today: 'warn', upcoming: '' };
  const rows = data[key] || [];
  const wrap = h('div', { class: 'card' },
    h('h3', {}, titleMap[key], ' ', h('span', { class: 'chip-count ' + klassMap[key] }, rows.length))
  );
  if (!rows.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'Nothing here. 🎉'));
    view.appendChild(wrap);
    return;
  }
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Lead'), h('th', {}, 'Phone'),
      h('th', {}, 'Assigned to'),
      h('th', {}, 'Due'),
      h('th', {}, 'Latest remark'), h('th', { style: { textAlign: 'right' } }, 'Actions')
    )),
    h('tbody', {}, ...rows.map(r => {
      const phone = String(r.lead_phone || '').trim();
      const telHref = phone ? 'tel:' + phone.replace(/[^\d+]/g, '') : null;
      const waHref  = phone ? 'https://wa.me/' + phone.replace(/[^\d]/g, '') : null;
      return h('tr', {},
        h('td', {}, h('a', { href: '#', onclick: ev => { ev.preventDefault(); openLeadModal(r.lead_id); } }, r.lead_name || '—')),
        h('td', {}, phone || ''),
        h('td', { class: r.assigned_name ? '' : 'muted' }, r.assigned_name || 'Unassigned'),
        h('td', { class: key === 'overdue' ? 'overdue' : '' }, fmtDate(r.due_at, 'relative')),
        h('td', { class: 'fu-latest-remark', title: r.latest_remark || '' },
          r.latest_remark ? String(r.latest_remark).slice(0, 80) + (String(r.latest_remark).length > 80 ? '…' : '') : h('span', { class: 'muted' }, '—')),
        h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
          telHref ? h('a', { class: 'btn sm primary', href: telHref }, '📞') : null,
          waHref  ? h('a', { class: 'btn sm ghost', href: waHref, target: '_blank', rel: 'noopener', style: { marginLeft: '.25rem' } }, '💬') : null,
          r.id ? h('button', { class: 'btn sm primary', style: { marginLeft: '.25rem' },
            onclick: () => openNextFollowupModal(r, () => navigateTo(key === 'overdue' ? 'overdue' : key === 'due_today' ? 'duetoday' : 'upcoming'))
          }, '⏰ Next') : null
        )
      );
    }))
  )));
  view.appendChild(wrap);
}

/**
 * "New today" sidebar shortcut — shows leads created today (in IST), reusing
 * the leads list with a server-applied date filter so it always matches the
 * dashboard "NEW TODAY" tile count.
 */
async function renderNewTodayLeads(view) {
  view.innerHTML = '';
  // IST today, formatted YYYY-MM-DD
  const tzFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = tzFmt.format(new Date());
  // Fetch leads filtered by created_at = today on the server.
  let rows = [];
  try {
    const r = await api('api_leads_list', { from: today, to: today, page_size: 500 });
    // api_leads_list returns { leads: [...], total, status_count, page, page_size }
    rows = (r && r.leads) || (r && r.rows) || [];
  } catch (e) { /* fall through */ }
  const wrap = h('div', { class: 'card' },
    h('h3', {}, '✨ New leads today ', h('span', { class: 'chip-count accent' }, rows.length))
  );
  if (!rows.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No new leads yet today.'));
    view.appendChild(wrap);
    return;
  }
  // Surface a small TAT-breach summary at the top so the rep can see
  // at a glance how many of today's leads are already past their stage
  // threshold (rare on day-of, but possible for short thresholds).
  const breachCount = rows.filter(l => l && l.tat_violation).length;
  if (breachCount > 0) {
    wrap.appendChild(h('div', { class: 'tat-banner' },
      '⚠ ', h('b', {}, breachCount), ' of today’s leads ',
      breachCount === 1 ? 'is' : 'are', ' already past TAT — action immediately.'));
  }
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Phone'), h('th', {}, 'Source'),
      h('th', {}, 'Status'), h('th', {}, 'Assigned to'), h('th', {}, 'Created')
    )),
    h('tbody', {}, ...rows.map(l => h('tr', {
      class: l.tat_violation ? 'row-tat-violation' : '',
      title: l.tat_violation ? tatViolationTitle(l) : null
    },
      h('td', {},
        h('a', { href: '#', onclick: ev => { ev.preventDefault(); openLeadModal(l.id); } }, l.name || '—'),
        l.tat_violation ? h('span', { class: 'tat-pill', title: tatViolationTitle(l) }, '⚠ TAT ', tatOverLabel(l)) : null
      ),
      h('td', {}, l.phone || ''),
      h('td', {}, l.source || ''),
      h('td', {}, l.status_name || ''),
      h('td', {}, l.assigned_name || ''),
      h('td', { class: 'muted' }, fmtDate(l.created_at, 'relative'))
    )))
  )));
  view.appendChild(wrap);
}

VIEWS.followups = async (view) => {
  const data = await api('api_notifications_mine');
  view.innerHTML = '';
  const section = (title, rows, klass) => {
    const wrap = h('div', { class: 'card' },
      h('h3', {}, title, ' ', h('span', { class: 'chip-count ' + (klass || '') }, rows.length))
    );
    if (!rows.length) { wrap.appendChild(h('p', { class: 'muted' }, 'Nothing here.')); view.appendChild(wrap); return; }
    const tbl = h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Lead'),
        h('th', {}, 'Phone'),
        h('th', {}, 'Assigned to'),
        h('th', {}, 'Due'),
        h('th', {}, 'Latest remark'),
        h('th', {}, 'Note'),
        h('th', { style: { textAlign: 'right' } }, 'Actions')
      )),
      h('tbody', {}, ...rows.map(r => {
        const phone = String(r.lead_phone || '').trim();
        const telHref = phone ? 'tel:' + phone.replace(/[^\d+]/g, '') : null;
        const waHref  = phone ? 'https://wa.me/' + phone.replace(/[^\d]/g, '') : null;
        return h('tr', {},
          h('td', {},
            h('a', { href: '#', onclick: ev => { ev.preventDefault(); openLeadModal(r.lead_id); } }, r.lead_name || '—')
          ),
          h('td', {}, phone || ''),
          h('td', { class: r.assigned_name ? '' : 'muted' }, r.assigned_name || 'Unassigned'),
          h('td', { class: klass === 'err' ? 'overdue' : '' }, fmtDate(r.due_at)),
          h('td', { class: 'fu-latest-remark', title: r.latest_remark || '' },
            r.latest_remark
              ? h('span', {}, String(r.latest_remark).slice(0, 120) + (String(r.latest_remark).length > 120 ? '…' : ''))
              : h('span', { class: 'muted' }, '—')
          ),
          h('td', { class: 'muted' }, r.note || ''),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            telHref ? h('a', { class: 'btn sm primary', href: telHref, title: 'Call ' + phone }, '📞 Call') : null,
            waHref  ? h('a', { class: 'btn sm ghost', href: waHref, target: '_blank', rel: 'noopener',
              style: { marginLeft: '.3rem' }, title: 'WhatsApp' }, '💬') : null,
            h('button', { class: 'btn sm', style: { marginLeft: '.3rem' },
              onclick: () => openLeadModal(r.lead_id), title: 'Open lead' }, '✎'),
            // "Next Follow Up" replaces the old "Done" button — opens a small
            // modal where the user picks a new date+time and writes a remark,
            // which closes the current follow-up AND creates the next one.
            // Forces the user to commit to a next action instead of just
            // dismissing the reminder.
            r.id ? h('button', { class: 'btn sm primary', style: { marginLeft: '.3rem' },
              onclick: () => openNextFollowupModal(r, () => navigateTo('followups'))
            }, '⏰ Next follow-up') : null
          )
        );
      }))
    ));
    wrap.appendChild(tbl);
    view.appendChild(wrap);
  };
  section('⚠️ Overdue', data.overdue, 'err');
  section('📅 Due today', data.due_today, 'warn');
  section('⏰ Upcoming', data.upcoming);
};

/* ---------------- Calendar ----------------------------------------
 * Full-month / week / day calendar showing every follow-up due date as
 * an event. Powered by FullCalendar (CDN-loaded on first visit so the
 * library only downloads when needed).
 *
 * Click an event → opens the lead modal so the rep can act immediately.
 * Admin/manager get a "Filter by user" dropdown so they can isolate
 * one rep's day.
 * ------------------------------------------------------------------ */

let _fcLib = null;
async function ensureFullCalendar() {
  if (window.FullCalendar) return window.FullCalendar;
  if (_fcLib) return _fcLib;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.11/index.global.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  _fcLib = window.FullCalendar;
  return _fcLib;
}

VIEWS.calendar = async (view) => {
  view.innerHTML = '';
  const FC = await ensureFullCalendar();
  const { users = [] } = CRM.cache;
  const isManager = ['admin', 'manager', 'team_leader'].includes(CRM.user.role);

  // Toolbar with user filter (admin/manager only) + a small legend
  const userSelect = h('select', { id: 'cal-user' },
    h('option', { value: '' }, 'All callers'),
    ...users.filter(u => Number(u.is_active) === 1).map(u => h('option', { value: u.id }, u.name))
  );
  const legend = h('div', { class: 'cal-legend muted' },
    h('span', { class: 'cal-dot', style: { background: '#ef4444' } }), ' Overdue ',
    h('span', { class: 'cal-dot', style: { background: '#f59e0b' } }), ' Due today ',
    h('span', { class: 'cal-dot', style: { background: '#3b82f6' } }), ' Upcoming ',
    h('span', { class: 'cal-dot', style: { background: '#10b981' } }), ' Done '
  );

  const toolbar = h('div', { class: 'toolbar', style: { marginBottom: '.75rem', alignItems: 'center' } },
    isManager ? h('span', { class: 'muted' }, 'Show:') : null,
    isManager ? userSelect : null,
    legend
  );
  const calRoot = h('div', { id: 'cal-root', style: { background: '#fff', borderRadius: '12px', padding: '1rem', boxShadow: '0 1px 3px rgba(0,0,0,.05)' } });
  view.append(toolbar, calRoot);

  let calendar;
  function buildCalendar() {
    if (calendar) calendar.destroy();
    calendar = new FC.Calendar(calRoot, {
      initialView: 'timeGridWeek',
      // Match the screenshot's controls: prev/next/today + month/week/day
      headerToolbar: {
        left:   'prev,next today',
        center: 'title',
        right:  'dayGridMonth,timeGridWeek,timeGridDay'
      },
      // Remember the last-chosen view across visits
      initialDate: new Date(),
      height: 'auto',
      slotMinTime: '07:00:00',
      slotMaxTime: '22:00:00',
      nowIndicator: true,
      navLinks: true,           // click a date in month view → jumps to day
      dayMaxEvents: true,       // collapse overflow as "+ more"
      // Pull events on demand whenever the visible range changes
      events: async (info, success, fail) => {
        try {
          const filterUser = $('#cal-user')?.value || undefined;
          const evs = await api('api_calendar_events', {
            from: info.startStr,
            to: info.endStr,
            assigned_to: filterUser || undefined
          });
          success(evs || []);
        } catch (e) {
          toast('Calendar load failed: ' + e.message, 'err');
          fail(e);
        }
      },
      // Click → open the lead modal so the rep can act
      eventClick: (info) => {
        const leadId = info.event.extendedProps.lead_id;
        if (leadId) openLeadModal(leadId);
        info.jsEvent?.preventDefault();
      },
      // Hover tooltip with phone + owner — useful in dense day views
      eventDidMount: (info) => {
        const p = info.event.extendedProps || {};
        const tip = [
          info.event.title,
          p.lead_phone ? '📞 ' + p.lead_phone : null,
          p.owner_name ? '👤 ' + p.owner_name : null,
          p.note ? '📝 ' + p.note : null,
          p.status ? '· ' + p.status : null
        ].filter(Boolean).join('\n');
        info.el.title = tip;
      }
    });
    calendar.render();
  }

  buildCalendar();
  if (userSelect) userSelect.onchange = () => calendar.refetchEvents();
};

/* ---------------- Knowledge Base -----------------------------------
 * Admin-curated reference content for the team — scripts, FAQs, offers,
 * brochures, pricing sheets, video links. Everyone can read; only admin
 * can create / edit / delete.
 *
 * Layout: category sidebar on the left, search box + entry list on the
 * right. Click an entry to open it in a modal with the full body, the
 * external URL (if any), tags, and copy-to-clipboard actions.
 * ------------------------------------------------------------------ */

const KB_CATEGORIES = [
  { id: 'all',      label: 'All',        icon: '📚' },
  { id: 'pinned',   label: 'Pinned',     icon: '📌' },
  { id: 'script',   label: 'Scripts',    icon: '🎯' },
  { id: 'faq',      label: 'FAQs',       icon: '❓' },
  { id: 'offer',    label: 'Offers',     icon: '🎁' },
  { id: 'brochure', label: 'Brochures',  icon: '📄' },
  { id: 'pricing',  label: 'Pricing',    icon: '💰' },
  { id: 'video',    label: 'Videos',     icon: '🎥' },
  { id: 'link',     label: 'Links',      icon: '🔗' },
  { id: 'other',    label: 'Other',      icon: '📌' }
];

VIEWS.knowledge = async (view) => {
  view.innerHTML = '';
  const isAdmin = CRM.user.role === 'admin';
  let activeCat = 'all';
  let query = '';

  // Sidebar — category list (acts as a filter)
  const sidebar = h('div', { class: 'kb-sidebar' });
  function renderSidebar() {
    sidebar.innerHTML = '';
    sidebar.appendChild(h('h4', { style: { margin: '0 0 .5rem' } }, '📚 Knowledge'));
    KB_CATEGORIES.forEach(c => {
      sidebar.appendChild(h('button', {
        class: 'kb-cat' + (c.id === activeCat ? ' active' : ''),
        onclick: () => { activeCat = c.id; renderSidebar(); refresh(); }
      }, c.icon + ' ' + c.label));
    });
  }
  renderSidebar();

  // Right pane — search box + add-button + entry list
  const right = h('div', { class: 'kb-main' });
  const searchInput = h('input', {
    type: 'search', placeholder: '🔍 Search title, body, tags or URL…',
    style: { flex: 1 }
  });
  let _searchTimer;
  searchInput.oninput = () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { query = searchInput.value || ''; refresh(); }, 250);
  };

  const toolbar = h('div', { class: 'toolbar', style: { marginBottom: '.75rem' } },
    searchInput,
    isAdmin ? h('button', { class: 'btn primary', onclick: () => openKbEditModal(null, refresh) }, '+ Add entry') : null
  );
  right.appendChild(toolbar);

  const listEl = h('div', { id: 'kb-list' });
  right.appendChild(listEl);

  view.appendChild(h('div', { class: 'kb-wrap' }, sidebar, right));

  async function refresh() {
    listEl.innerHTML = '<div class="loading">Loading…</div>';
    let rows;
    try {
      const filters = { q: query };
      if (activeCat !== 'all' && activeCat !== 'pinned') filters.category = activeCat;
      rows = await api('api_kb_list', filters);
    } catch (e) {
      listEl.innerHTML = '';
      listEl.appendChild(h('div', { class: 'error-box' }, e.message));
      return;
    }
    if (activeCat === 'pinned') rows = rows.filter(r => r.is_pinned);
    listEl.innerHTML = '';
    if (!rows.length) {
      listEl.appendChild(h('p', { class: 'muted' }, query
        ? 'No entries matching "' + esc(query) + '"'
        : (isAdmin ? 'No entries yet — click "+ Add entry" to create the first one.' : 'No entries in this category yet.')));
      return;
    }
    rows.forEach(r => listEl.appendChild(kbCard(r, refresh, isAdmin)));
  }

  await refresh();
};

function kbCard(r, refresh, isAdmin) {
  const cat = KB_CATEGORIES.find(c => c.id === r.category) || KB_CATEGORIES.find(c => c.id === 'other');
  const card = h('div', { class: 'kb-card' + (r.is_pinned ? ' pinned' : '') },
    h('div', { class: 'kb-card-head' },
      h('div', {},
        r.is_pinned ? h('span', { class: 'kb-pin' }, '📌 ') : null,
        h('span', { class: 'kb-cat-tag' }, cat.icon + ' ' + cat.label),
        r.product_name ? h('span', { class: 'kb-cat-tag', style: { background: '#ddd6fe', color: '#5b21b6' } }, '📦 ' + r.product_name) : null
      ),
      h('div', { class: 'muted', style: { fontSize: '.75rem' } }, fmtDate(r.updated_at, 'relative'))
    ),
    h('h4', { class: 'kb-title', onclick: () => openKbViewModal(r.id) }, r.title),
    r.body ? h('p', { class: 'kb-body-preview' },
      String(r.body).slice(0, 220) + (String(r.body).length > 220 ? '…' : '')
    ) : null,
    r.tags ? h('div', { class: 'kb-tags' },
      ...String(r.tags).split(',').map(t => t.trim()).filter(Boolean)
        .map(t => h('span', { class: 'kb-tag' }, '#' + t))
    ) : null,
    h('div', { class: 'kb-actions' },
      h('button', { class: 'btn sm', onclick: () => openKbViewModal(r.id) }, '👁 Open'),
      r.url ? h('a', { class: 'btn sm ghost', href: r.url, target: '_blank', rel: 'noopener' }, '🔗 Link') : null,
      r.body ? h('button', { class: 'btn sm ghost', onclick: () => {
        navigator.clipboard?.writeText(r.body).then(() => toast('Copied'));
      }, title: 'Copy body to clipboard' }, '📋 Copy') : null,
      isAdmin ? h('button', { class: 'btn sm ghost', onclick: () => openKbEditModal(r.id, refresh) }, '✎') : null,
      isAdmin ? h('button', { class: 'btn sm ghost', onclick: async () => {
        if (!confirm('Hide this entry from the team? (Soft-delete; admin can restore later.)')) return;
        try { await api('api_kb_delete', r.id); toast('Hidden'); refresh(); }
        catch (e) { toast(e.message, 'err'); }
      }, title: 'Hide / soft-delete' }, '🗑') : null
    )
  );
  return card;
}

async function openKbViewModal(id) {
  let entry;
  try { entry = await api('api_kb_get', id); }
  catch (e) { toast(e.message, 'err'); return; }
  const cat = KB_CATEGORIES.find(c => c.id === entry.category) || { icon: '📌', label: entry.category };
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' },
        h('h3', {}, entry.is_pinned ? '📌 ' : '', entry.title),
        h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
      ),
      h('div', { class: 'modal-body' },
        h('div', { class: 'kb-meta-row' },
          h('span', { class: 'kb-cat-tag' }, cat.icon + ' ' + cat.label),
          entry.product_name ? h('span', { class: 'kb-cat-tag', style: { background: '#ddd6fe', color: '#5b21b6' } }, '📦 ' + entry.product_name) : null,
          entry.created_by_name ? h('span', { class: 'muted', style: { fontSize: '.78rem' } }, 'by ' + entry.created_by_name) : null,
          h('span', { class: 'muted', style: { fontSize: '.78rem' } }, fmtDate(entry.updated_at))
        ),
        entry.url ? h('p', {}, h('a', { class: 'btn primary', href: entry.url, target: '_blank', rel: 'noopener' }, '🔗 Open external link')) : null,
        entry.body ? h('div', { class: 'kb-body-full' }, entry.body) : h('p', { class: 'muted' }, '(No body content — use the link above.)'),
        entry.tags ? h('div', { class: 'kb-tags' },
          ...String(entry.tags).split(',').map(t => t.trim()).filter(Boolean)
            .map(t => h('span', { class: 'kb-tag' }, '#' + t))
        ) : null,
        entry.body ? h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => {
            navigator.clipboard?.writeText(entry.body).then(() => toast('Copied to clipboard'));
          } }, '📋 Copy body')
        ) : null
      )
    )
  );
  document.body.appendChild(m);
}

async function openKbEditModal(id, onSave) {
  const { products = [] } = CRM.cache;
  let entry = { title: '', category: 'script', body: '', url: '', tags: '', product_id: '', is_pinned: 0 };
  if (id) {
    try { entry = await api('api_kb_get', id); }
    catch (e) { toast(e.message, 'err'); return; }
  }
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  m.appendChild(body);
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, id ? 'Edit knowledge entry' : 'New knowledge entry'),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));

  const form = h('form', { id: 'kb-form', class: 'form-grid' });
  const catOptions = KB_CATEGORIES
    .filter(c => c.id !== 'all' && c.id !== 'pinned')
    .map(c => ({ value: c.id, label: c.icon + ' ' + c.label }));
  const productOptions = [{ value: '', label: '— None —' }, ...products.map(p => ({ value: p.id, label: p.name }))];
  form.append(
    field('title', 'Title *', entry.title, { required: true, full: true }),
    selectField('category', 'Category *', entry.category, catOptions),
    selectField('product_id', 'Related product (optional)', entry.product_id || '', productOptions),
    field('url', 'External URL (Drive / Box / YouTube — optional)', entry.url, { full: true }),
    field('tags', 'Tags (comma-separated)', entry.tags, { full: true }),
    field('body', 'Body / Content', entry.body, { type: 'textarea', full: true }),
    h('div', { class: 'f-row' },
      h('label', {}, 'Pin to top'),
      h('label', { class: 'qual-toggle' },
        h('input', { type: 'checkbox', name: 'is_pinned', checked: entry.is_pinned ? 'checked' : null }),
        ' Show this entry at the top of every category'
      )
    )
  );
  body.appendChild(form);

  body.appendChild(h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'btn', onclick: () => m.remove() }, 'Cancel'),
    h('button', { type: 'submit', form: 'kb-form', class: 'btn primary' }, id ? 'Save changes' : 'Create entry')
  ));

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = form;
    const fd = new FormData(f);
    const payload = {
      id: id || undefined,
      title: f.title.value.trim(),
      category: f.category.value,
      body: f.body.value,
      url: f.url.value.trim(),
      tags: f.tags.value.trim(),
      product_id: f.product_id.value || null,
      is_pinned: fd.get('is_pinned') ? 1 : 0
    };
    if (!payload.title) { toast('Title is required', 'err'); return; }
    try {
      await api('api_kb_save', payload);
      toast(id ? 'Saved' : 'Created');
      m.remove();
      if (typeof onSave === 'function') onSave();
    } catch (e) { toast(e.message, 'err'); }
  });

  document.body.appendChild(m);
}

/* ---------------- Team Chat (internal) -----------------------------
 * Single team channel + 1-on-1 DMs to any user. Polling-based: thread
 * list refreshes every 10s, active conversation every 4s while open.
 * Reuses the WhatsBot chat polling pattern so the network footprint is
 * predictable. Stops polling when the user navigates to a different tab.
 * ------------------------------------------------------------------ */

/**
 * Pull a query-string-style param out of the location hash.
 * `#/teamchat?room=42&foo=bar` → parseHashParams().room === '42'
 */
function parseHashParams() {
  const hash = String(location.hash || '');
  const i = hash.indexOf('?');
  if (i < 0) return {};
  return Object.fromEntries(new URLSearchParams(hash.slice(i + 1)));
}

VIEWS.teamchat = async (view) => {
  // Kill any previous timers if the tab is reopened
  if (window._tcTimers) {
    clearInterval(window._tcTimers.list);
    clearInterval(window._tcTimers.thread);
  }
  window._tcTimers = { list: null, thread: null };

  // Top-level guard — surface any unexpected failure as a readable card
  // instead of a raw stack trace. Common cause: the boot didn't finish
  // resolving CRM.user / CRM.access before a deep-link tried to open chat.
  if (!CRM.user || !CRM.user.id) {
    view.innerHTML = '<div class="error-box">Session not ready — please refresh and try again.</div>';
    return;
  }

  view.innerHTML = '';
  const wrap = h('div', { class: 'wb-chat' });
  const left = h('div', { class: 'wb-chat-list' });
  const right = h('div', { class: 'wb-chat-thread' },
    h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, '← Pick a channel or DM'));
  wrap.appendChild(left); wrap.appendChild(right);
  view.appendChild(wrap);

  // Pre-load every user the caller is allowed to chat with — this is
  // independent of CRM.cache.users (which is filtered by lead-management
  // hierarchy and would hide the rest of the team from a sales rep).
  let chatUsers = [];
  try { chatUsers = await api('api_chat_visibleUsers'); }
  catch (e) {
    if (String(e.message || '').includes('not enabled')) {
      view.innerHTML = `<div class="card" style="padding: 2rem; text-align: center;">
        <h3>💬 Team chat</h3>
        <p class="muted">Team chat isn't enabled for your role. Ask your admin to enable it in Settings → Chat permissions.</p>
      </div>`;
      return;
    }
    chatUsers = [];
  }

  let openRoomId = null;
  let openMsgFingerprint = '';
  let lastListFingerprint = '';

  function listFp(rooms) {
    return rooms.map(r => `${r.id}|${r.last_at}|${r.unread}`).join(';');
  }
  function msgFp(msgs) {
    return msgs.map(m => m.id).join(';');
  }

  async function renderThreadList() {
    let rooms;
    try { rooms = await api('api_chat_rooms_list'); }
    catch (_) { rooms = []; }

    // Also include every other active user as a potential DM target —
    // even if no DM thread exists yet — so the user can start one.
    // Uses the pre-loaded chatUsers (from api_chat_visibleUsers) which is
    // NOT filtered by lead-management hierarchy. CRM.cache.users would
    // hide the rest of the team from sales/employee role.
    const usersInList = new Set(rooms.filter(r => r.type === 'dm').map(r => r.counterpart_id));
    const otherUsers = chatUsers
      .filter(u => Number(u.id) !== Number(CRM.user.id))
      .filter(u => !usersInList.has(Number(u.id)));

    const fp = listFp(rooms) + '|users:' + otherUsers.length;
    if (fp === lastListFingerprint) return;
    lastListFingerprint = fp;

    left.innerHTML = '';
    const isAdmin = CRM.user.role === 'admin';
    left.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.5rem' } },
      h('h4', { style: { margin: 0 } }, '👥 Team chat'),
      h('div', {},
        isAdmin ? h('button', { class: 'btn sm ghost', title: 'Create a new group',
          onclick: () => openCreateGroupModal(chatUsers, () => { lastListFingerprint = ''; renderThreadList(); })
        }, '+ Group') : null,
        h('button', { class: 'btn sm ghost', style: { marginLeft: '.25rem' }, title: 'Refresh now',
          onclick: () => { lastListFingerprint = ''; renderThreadList(); if (openRoomId) renderActiveThread(true); }
        }, '↻')
      )
    ));

    // Org-wide team channel first
    rooms.filter(r => r.type === 'channel' && r.label === 'team').forEach(r => left.appendChild(renderRoomRow(r)));
    // Custom groups next, with their own section header
    const groupRooms = rooms.filter(r => r.type === 'channel' && r.label !== 'team');
    if (groupRooms.length) {
      left.appendChild(h('div', { class: 'muted', style: { fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.05em', margin: '.75rem 0 .25rem .25rem' } }, 'Groups'));
      groupRooms.forEach(r => left.appendChild(renderRoomRow(r)));
    }
    // DM rooms with existing messages
    const dmRooms = rooms.filter(r => r.type === 'dm');
    if (dmRooms.length) {
      left.appendChild(h('div', { class: 'muted', style: { fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.05em', margin: '.75rem 0 .25rem .25rem' } }, 'Direct messages'));
      dmRooms.forEach(r => left.appendChild(renderRoomRow(r)));
    }
    // Users who don't yet have a DM thread — so you can start one
    if (otherUsers.length) {
      left.appendChild(h('div', { class: 'muted', style: { fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.05em', margin: '.75rem 0 .25rem .25rem' } }, 'Start a DM'));
      otherUsers.forEach(u => {
        left.appendChild(h('div', { class: 'wb-chat-row', onclick: () => startDmWith(u.id) },
          h('div', {}, h('b', {}, u.name)),
          h('div', { class: 'muted', style: { fontSize: '.78rem' } }, u.role || '')
        ));
      });
    }
  }

  function renderRoomRow(r) {
    return h('div', { class: 'wb-chat-row' + (r.id === openRoomId ? ' active' : ''),
      onclick: () => openRoom(r.id, r.label, r.type)
    },
      h('div', {},
        r.type === 'channel' ? h('span', {}, '# ') : null,
        h('b', {}, r.label || ('Room #' + r.id)),
        r.unread ? h('span', { class: 'wb-unread' }, r.unread) : null
      ),
      h('div', { class: 'muted', style: { fontSize: '.78rem', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        r.last_message_user ? r.last_message_user + ': ' : '',
        r.last_message || ''),
      h('div', { class: 'muted', style: { fontSize: '.7rem' } }, fmtDate(r.last_at, 'relative'))
    );
  }

  async function startDmWith(userId) {
    // Resolve the target user from the chat-visibleUsers list (NOT
    // CRM.cache.users which is hierarchy-filtered).
    const u = chatUsers.find(x => Number(x.id) === Number(userId));
    openRoomId = 'pending:' + userId;
    wrap.classList.add('thread-open');
    [...left.querySelectorAll('.wb-chat-row')].forEach(r => r.classList.remove('active'));
    right.innerHTML = '';
    right.appendChild(h('div', { class: 'wb-chat-head', style: { display: 'flex', alignItems: 'center' } },
      h('button', { class: 'wb-chat-back', title: 'Back to list', onclick: backToList }, '← Back'),
      h('b', {}, u?.name || 'New DM')));
    const log = h('div', { class: 'wb-chat-log' });
    log.appendChild(h('p', { class: 'muted', style: { padding: '1.5rem', textAlign: 'center' } },
      'Type a message to start a DM with ' + (u?.name || 'this user')));
    right.appendChild(log);
    const input = makeChatInput(async (text) => {
      try {
        const r = await api('api_chat_send', { user_id: userId, body: text });
        openRoomId = r.room_id;
        lastListFingerprint = ''; await renderThreadList();
        // Switch to the now-real room
        await openRoom(r.room_id, u?.name || 'DM', 'dm');
      } catch (e) { toast(e.message, 'err'); }
    });
    right.appendChild(input);
  }

  async function renderActiveThread(force) {
    if (!openRoomId || String(openRoomId).startsWith('pending:')) return;
    let msgs;
    try { msgs = await api('api_chat_messages_list', openRoomId); }
    catch (_) { msgs = []; }
    const fp = msgFp(msgs);
    if (!force && fp === openMsgFingerprint) return;
    openMsgFingerprint = fp;
    const log = right.querySelector('.wb-chat-log');
    if (!log) return;
    const wasNearBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 80;
    log.innerHTML = '';
    msgs.forEach(m => {
      log.appendChild(h('div', { class: 'wb-msg ' + (m.is_mine ? 'out' : 'in') },
        h('div', { class: 'wb-msg-meta muted' }, m.user_name + ' · ' + fmtDate(m.created_at, 'relative')),
        h('div', { class: 'wb-msg-body' }, m.body || '')
      ));
    });
    if (wasNearBottom) setTimeout(() => { log.scrollTop = log.scrollHeight; }, 50);
  }

  function makeChatInput(onSend) {
    const input = h('textarea', { rows: 2, placeholder: 'Type a message and press Enter to send…' });
    input.addEventListener('keydown', async ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        const text = input.value.trim(); if (!text) return;
        input.disabled = true;
        try { await onSend(text); input.value = ''; }
        finally { input.disabled = false; input.focus(); }
      }
    });
    return h('div', { class: 'wb-chat-compose' }, input);
  }

  function backToList() {
    openRoomId = null;
    window._tcOpenRoomId = null;
    openMsgFingerprint = '';
    wrap.classList.remove('thread-open');
    [...left.querySelectorAll('.wb-chat-row')].forEach(r => r.classList.remove('active'));
    right.innerHTML = h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, '← Pick a channel or DM').outerHTML;
  }

  async function openRoom(roomId, label, type) {
    openRoomId = roomId;
    window._tcOpenRoomId = roomId;       // exposed so the in-app chat toast
                                          // can suppress popups for the room
                                          // the user is actively reading
    openMsgFingerprint = '';
    wrap.classList.add('thread-open');  // mobile: hide list, show thread
    [...left.querySelectorAll('.wb-chat-row')].forEach(r => r.classList.remove('active'));

    const isAdmin = CRM.user.role === 'admin';
    // Manage button only for admin AND only on custom groups (not the
    // org-wide 'team' channel and not DMs).
    const canManage = isAdmin && type === 'channel' && label !== 'team';

    right.innerHTML = '';
    right.appendChild(h('div', { class: 'wb-chat-head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      h('div', { style: { display: 'flex', alignItems: 'center' } },
        h('button', { class: 'wb-chat-back', title: 'Back to list', onclick: backToList }, '← Back'),
        h('b', {}, type === 'channel' ? '# ' + label : label)
      ),
      h('div', {},
        canManage ? h('button', { class: 'btn sm ghost', title: 'Manage members / rename / delete',
          onclick: () => openManageGroupModal(roomId, label, chatUsers, () => { lastListFingerprint = ''; renderThreadList(); })
        }, '⚙') : null,
        h('button', { class: 'btn sm ghost', style: { marginLeft: '.25rem' }, title: 'Refresh',
          onclick: () => renderActiveThread(true) }, '↻')
      )
    ));
    const log = h('div', { class: 'wb-chat-log' });
    log.innerHTML = '<div class="loading">Loading…</div>';
    right.appendChild(log);

    const input = makeChatInput(async (text) => {
      try {
        await api('api_chat_send', { room_id: roomId, body: text });
        renderActiveThread(true);
        lastListFingerprint = ''; renderThreadList();
      } catch (e) { toast(e.message, 'err'); }
    });
    right.appendChild(input);

    await renderActiveThread(true);
    lastListFingerprint = ''; await renderThreadList();
    // Reading a room marks it read server-side — refresh the sidebar
    // badge immediately so the count drops without waiting 10s.
    if (typeof _updateChatBadge === 'function') _updateChatBadge();
  }

  await renderThreadList();

  // Deep-link from a notification — if the URL hash includes ?room=N,
  // auto-open that conversation so the user lands inside the DM with one
  // tap, not on the room list.
  try {
    const params = parseHashParams();
    if (params.room) {
      const targetId = Number(params.room);
      // Look up label + type from the rooms list we just rendered
      const allRooms = await api('api_chat_rooms_list').catch(() => []);
      const room = allRooms.find(r => Number(r.id) === targetId);
      if (room) {
        await openRoom(room.id, room.label, room.type);
      } else {
        // Room exists but not in our list (e.g. brand-new DM the server
        // hasn't surfaced yet) — fetch messages directly to bootstrap it
        await openRoom(targetId, 'Conversation', 'dm');
      }
    }
  } catch (e) {
    console.warn('[teamchat] deep-link failed:', e.message);
  }

  window._tcTimers.list = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    renderThreadList().catch(() => {});
  }, 10_000);
  window._tcTimers.thread = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (openRoomId && !String(openRoomId).startsWith('pending:')) {
      renderActiveThread(false).catch(() => {});
    }
  }, 4_000);
};

/**
 * Modal: admin creates a new chat group with a name + member checkboxes.
 * The creator is auto-included server-side.
 */
function openCreateGroupModal(allUsers, onSaved) {
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  m.appendChild(body);
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, '➕ New chat group'),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));
  const form = h('form', { id: 'gc-form' });
  form.appendChild(h('p', { class: 'muted', style: { marginTop: 0 } },
    'Pick a name and the members. Only the people you tick can see the group and post in it.'));
  form.appendChild(h('input', { name: 'name', placeholder: 'Group name (e.g. Sales — North zone)',
    style: { width: '100%', padding: '.6rem .75rem', borderRadius: '8px', border: '1px solid #cbd5e1', marginBottom: '.75rem' },
    required: true, maxlength: 80
  }));
  const memberBox = h('div', { class: 'card', style: { padding: '.75rem', maxHeight: '320px', overflowY: 'auto' } });
  (allUsers || []).filter(u => Number(u.id) !== Number(CRM.user.id)).forEach(u => {
    memberBox.appendChild(h('label', {
      style: { display: 'flex', alignItems: 'center', padding: '.3rem 0', cursor: 'pointer' }
    },
      h('input', { type: 'checkbox', name: 'mem_' + u.id, style: { marginRight: '.5rem' } }),
      h('span', { style: { fontWeight: 500 } }, u.name),
      h('span', { class: 'muted', style: { marginLeft: '.5rem', fontSize: '.78rem' } }, ' · ' + (u.role || ''))
    ));
  });
  form.appendChild(memberBox);
  body.appendChild(form);
  body.appendChild(h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'btn', onclick: () => m.remove() }, 'Cancel'),
    h('button', { type: 'submit', form: 'gc-form', class: 'btn primary' }, 'Create group')
  ));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const name = form.name.value.trim();
    if (!name) { toast('Group name required', 'err'); return; }
    const memberIds = [...form.querySelectorAll('input[type="checkbox"]:checked')]
      .map(c => Number(c.name.replace(/^mem_/, '')));
    try {
      await api('api_chat_groups_create', { name, member_ids: memberIds });
      toast('Group created');
      m.remove();
      if (typeof onSaved === 'function') onSaved();
    } catch (e) { toast(e.message, 'err'); }
  });
  document.body.appendChild(m);
}

/**
 * Modal: admin renames / re-sets members / deletes an existing group.
 * Pre-fills with current members.
 */
async function openManageGroupModal(roomId, currentName, allUsers, onSaved) {
  let currentMembers = [];
  try { currentMembers = await api('api_chat_groups_members', roomId); }
  catch (e) { toast(e.message, 'err'); return; }
  const memberIds = new Set(currentMembers.map(m => Number(m.user_id)));

  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  m.appendChild(body);
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, '⚙ Manage group'),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));

  const form = h('form', { id: 'gm-form' });
  form.appendChild(h('label', { class: 'muted', style: { fontSize: '.8rem' } }, 'Group name'));
  form.appendChild(h('input', { name: 'name', value: currentName,
    style: { width: '100%', padding: '.6rem .75rem', borderRadius: '8px', border: '1px solid #cbd5e1', marginBottom: '.75rem' },
    required: true, maxlength: 80
  }));
  form.appendChild(h('label', { class: 'muted', style: { fontSize: '.8rem' } },
    'Members — tick to include. Removing yourself is blocked (server force-includes admin).'));
  const memberBox = h('div', { class: 'card', style: { padding: '.75rem', maxHeight: '320px', overflowY: 'auto' } });
  (allUsers || []).forEach(u => {
    memberBox.appendChild(h('label', {
      style: { display: 'flex', alignItems: 'center', padding: '.3rem 0', cursor: 'pointer' }
    },
      h('input', {
        type: 'checkbox', name: 'mem_' + u.id,
        checked: memberIds.has(Number(u.id)) ? 'checked' : null,
        style: { marginRight: '.5rem' }
      }),
      h('span', { style: { fontWeight: 500 } }, u.name),
      h('span', { class: 'muted', style: { marginLeft: '.5rem', fontSize: '.78rem' } }, ' · ' + (u.role || ''))
    ));
  });
  form.appendChild(memberBox);
  body.appendChild(form);

  body.appendChild(h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'btn', style: { background: '#ef4444', color: '#fff' },
      onclick: async () => {
        if (!confirm('Permanently delete this group and all its messages?')) return;
        try {
          await api('api_chat_groups_delete', roomId);
          toast('Deleted');
          m.remove();
          if (typeof onSaved === 'function') onSaved();
        } catch (e) { toast(e.message, 'err'); }
      }
    }, '🗑 Delete'),
    h('button', { type: 'button', class: 'btn', onclick: () => m.remove() }, 'Cancel'),
    h('button', { type: 'submit', form: 'gm-form', class: 'btn primary' }, 'Save changes')
  ));

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const newName = form.name.value.trim();
    if (!newName) { toast('Group name required', 'err'); return; }
    const newIds = [...form.querySelectorAll('input[type="checkbox"]:checked')]
      .map(c => Number(c.name.replace(/^mem_/, '')));
    try {
      await api('api_chat_groups_update', {
        id: roomId, name: newName, member_ids: newIds
      });
      toast('Saved');
      m.remove();
      if (typeof onSaved === 'function') onSaved();
    } catch (e) { toast(e.message, 'err'); }
  });
  document.body.appendChild(m);
}

/* ---------------- Reports with charts ---------------- */
async function ensureChartJs() {
  if (!window.Chart) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  // Also load chartjs-plugin-datalabels so we can render the actual numeric
  // value on top of every bar / segment (the user wants numbers visible, not
  // just bars). Register globally so every chart picks it up.
  if (window.Chart && !window.ChartDataLabels) {
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
      if (window.ChartDataLabels && Chart && Chart.register) Chart.register(window.ChartDataLabels);
    } catch (_) { /* non-fatal: charts still render, just without labels */ }
  }
}
/* ============================================================
   WhatsBot module — Connect / Templates / Bots / Campaigns / Chat / Logs
   ============================================================ */
/**
 * Dial route — opened on the user's phone when they tap a "Call from mobile"
 * push. Hash query params: ?phone=+91...&lead=N
 *
 * Auto-fires tel: which the OS dialer opens. Shows a fallback button in
 * case auto-launch is suppressed (some browsers block `tel:` redirects from
 * non-user-initiated navigation).
 */
VIEWS.dial = async (view) => {
  view.innerHTML = '';
  const hash = location.hash || '';
  const queryStr = hash.split('?')[1] || '';
  const params = new URLSearchParams(queryStr);
  const phone = (params.get('phone') || '').trim();
  if (!phone) {
    view.appendChild(h('div', { class: 'error-box' }, 'No phone number in the URL.'));
    return;
  }
  const tel = 'tel:' + phone.replace(/\s+/g, '');
  const status = h('div', { class: 'muted', style: { fontSize: '.8rem', marginTop: '.5rem' } });

  async function autoDial() {
    const cap = window.Capacitor;
    const tries = [];
    // Strategy 1 — Capacitor App.openUrl (Android: launches ACTION_DIAL)
    try {
      if (cap && cap.Plugins && cap.Plugins.App && typeof cap.Plugins.App.openUrl === 'function') {
        const r = await cap.Plugins.App.openUrl({ url: tel });
        tries.push('App.openUrl→' + JSON.stringify(r));
        if (r && r.completed !== false) { status.textContent = '✓ Launched via App.openUrl'; return 'capacitor'; }
      } else { tries.push('no App.openUrl'); }
    } catch (e) { tries.push('App.openUrl threw: ' + e.message); }
    // Strategy 2 — window.open with _system
    try {
      const w = window.open(tel, '_system');
      tries.push('window.open(_system)→' + (w ? 'win' : 'null'));
      if (w) { status.textContent = '✓ Launched via window.open'; return 'window'; }
    } catch (e) { tries.push('window.open threw: ' + e.message); }
    // Strategy 3 — invisible iframe (works in some WebViews where href doesn't)
    try {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      f.src = tel;
      document.body.appendChild(f);
      tries.push('iframe→appended');
      setTimeout(() => f.remove(), 1000);
      status.textContent = '✓ Launched via iframe';
      return 'iframe';
    } catch (e) { tries.push('iframe threw: ' + e.message); }
    // Strategy 4 — programmatic anchor click (very reliable in WebViews)
    try {
      const a = document.createElement('a');
      a.href = tel; a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      tries.push('anchor.click()→fired');
      setTimeout(() => a.remove(), 100);
      status.textContent = '✓ Launched via anchor.click()';
      return 'anchor';
    } catch (e) { tries.push('anchor.click threw: ' + e.message); }
    // Strategy 5 — plain href
    try { location.href = tel; tries.push('location.href set'); status.textContent = '✓ Launched via location.href'; return 'href'; } catch (e) { tries.push('location.href threw: ' + e.message); }
    status.innerHTML = '<span style="color:#ef4444">All strategies failed: ' + tries.join(' · ') + '</span>';
    return 'failed';
  }

  setTimeout(() => { autoDial().catch(() => {}); }, 150);

  view.appendChild(h('div', { style: { maxWidth: '420px', margin: '1rem auto', textAlign: 'center', padding: '1rem' } },
    h('div', { style: { fontSize: '4rem', marginTop: '1rem' } }, '📞'),
    h('h1', { style: { margin: '.5rem 0', fontSize: '1.5rem' } }, 'Calling…'),
    h('p', { style: { fontSize: '1.4rem', fontWeight: '700', fontFamily: 'monospace', margin: '.5rem 0 1.5rem' } }, phone),
    // Hard anchor tap — most reliable path inside Capacitor WebView. Tapping
    // an <a href="tel:..."> is treated as a real Intent launch by Android.
    h('a', { class: 'btn primary', style: { display: 'block', fontSize: '1.4rem', padding: '1.25rem', background: '#10b981', color: '#fff', border: 'none', borderRadius: '12px', textDecoration: 'none', fontWeight: '600' }, href: tel },
      '📞 CALL NOW'
    ),
    status,
    h('a', { class: 'btn ghost', style: { marginTop: '1.25rem', display: 'inline-block' }, href: '#/leads' }, '← Back to leads')
  ));
};

VIEWS.whatsbot = async (view) => {
  view.innerHTML = '';
  const tabs = [
    { id: 'connect',   label: '🔗 Connect Account' },
    { id: 'templates', label: '📋 Templates' },
    { id: 'msgbots',   label: '💬 Message Bot' },
    { id: 'tplbots',   label: '🤖 Template Bot' },
    { id: 'campaigns', label: '📣 Campaigns' },
    { id: 'chat',      label: '💭 Chat' },
    { id: 'assign',    label: '👥 Auto-assign' },
    { id: 'activity',  label: '📑 Activity Log' }
  ];
  const nav = h('div', { class: 'subtabs' },
    ...tabs.map(t => h('button', { class: 'subtab', 'data-wbtab': t.id, onclick: () => showWbTab(t.id) }, t.label))
  );
  view.appendChild(nav);
  view.appendChild(h('div', { id: 'wb-body' }));
  const startTab = (location.hash.match(/whatsbot\/([a-z]+)/i) || [])[1] || 'connect';
  showWbTab(startTab);
};

async function showWbTab(id) {
  // Stop any running chat-polling timers if we're navigating away from chat.
  // Otherwise they'd keep firing every 4-8s in the background even after the
  // user has switched to e.g. Templates or Activity.
  if (id !== 'chat' && window._wbChatTimers) {
    clearInterval(window._wbChatTimers.threadList);
    clearInterval(window._wbChatTimers.activeThread);
    window._wbChatTimers = null;
  }
  $$('.subtab').forEach(b => b.classList.toggle('active', b.dataset.wbtab === id));
  const body = $('#wb-body');
  body.innerHTML = '<div class="loading">Loading…</div>';
  try {
    if (id === 'connect')   body.replaceChildren(await wbConnect());
    if (id === 'templates') body.replaceChildren(await wbTemplates());
    if (id === 'msgbots')   body.replaceChildren(await wbMessageBots());
    if (id === 'tplbots')   body.replaceChildren(await wbTemplateBots());
    if (id === 'campaigns') body.replaceChildren(await wbCampaigns());
    if (id === 'chat')      body.replaceChildren(await wbChat());
    if (id === 'assign')    body.replaceChildren(await wbAssignSettings());
    if (id === 'activity')  body.replaceChildren(await wbActivity());
    location.hash = '#/whatsbot/' + id;
  } catch (e) { body.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
}

// ---------- Connect Account ----------
async function wbConnect() {
  const s = await api('api_wb_settings_get');
  const wrap = h('div', { class: 'wb-connect' });
  const isConnected = !!(s.access_token_present && s.waba_id && s.phone_number_id);
  const fbReady = !!(s.fb_app_id && s.fb_app_secret_set && s.fb_config_id);
  // Preload the FB SDK now so that when the user clicks "Connect with
  // Facebook" later, FB.login runs SYNCHRONOUSLY inside the click handler.
  // Without this, Chrome (and most browsers) block the popup because the
  // user-gesture has already expired by the time the async SDK fetch returns.
  if (s.fb_app_id) {
    ensureFbSdkLoaded(s.fb_app_id).catch(e => console.warn('[wb] FB SDK preload failed:', e.message));
  }

  // Embedded vs Manual mode toggle — matches the screenshot's layout.
  // Default ON unless the admin has explicitly stored a manual-only setup.
  const embKey = 'wb_emb_signin_on';
  let embOn = localStorage.getItem(embKey);
  embOn = embOn === null ? true : embOn === '1';

  // ---- Header: title + "Enable embedded SignIn" toggle on the right ----
  const header = h('div', { class: 'wb-conn-head' },
    h('h2', {}, 'WhatsApp business account'),
    h('label', { class: 'wb-emb-toggle' },
      h('span', {}, 'Enable embedded SignIn'),
      (() => {
        const sw = h('span', { class: 'switch' + (embOn ? ' on' : '') });
        const inp = h('input', { type: 'checkbox', checked: embOn ? 'checked' : null });
        inp.onchange = () => {
          embOn = inp.checked;
          localStorage.setItem(embKey, embOn ? '1' : '0');
          sw.classList.toggle('on', embOn);
          showWbTab('connect'); // re-render
        };
        sw.appendChild(inp);
        sw.appendChild(h('span', { class: 'slider' }));
        return sw;
      })()
    )
  );
  wrap.appendChild(header);

  // ---- Connected status banner (always show if connected) ----
  if (isConnected) {
    wrap.appendChild(h('div', { class: 'card wb-conn-status' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' } },
        h('div', { style: { fontSize: '1.5rem' } }, '✅'),
        h('div', { style: { flex: 1, minWidth: '200px' } },
          h('b', {}, 'WhatsApp connected'),
          h('div', { class: 'muted', style: { fontSize: '.85rem' } },
            'WABA: ', h('code', {}, s.waba_id), ' · Phone ID: ', h('code', {}, s.phone_number_id))
        ),
        h('button', { class: 'btn sm', onclick: async () => {
          try {
            const r = await api('api_wb_connect_verify');
            if (r.ok) toast(`${r.display_phone_number} · Quality ${r.quality_rating || '—'} · ${r.status || ''}`);
            else toast(r.error || 'Verify failed', 'err');
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Verify'),
        // Register the phone number with Cloud API — required once before
        // any send works. Without this, Meta returns 'account not registered'.
        h('button', { class: 'btn sm', title: 'Required once after connecting — registers the phone with WhatsApp Cloud API.',
          onclick: () => openRegisterPhoneModal()
        }, '🔐 Register phone'),
        h('button', { class: 'btn sm ghost danger', onclick: async () => {
          if (!await confirmDialog('Disconnect WhatsApp? Stored tokens will be cleared.')) return;
          try { await api('api_wb_disconnect'); toast('Disconnected'); showWbTab('connect'); }
          catch (e) { toast(e.message, 'err'); }
        } }, 'Disconnect')
      ),
      h('p', { class: 'muted', style: { fontSize: '.82rem', marginTop: '.5rem', marginBottom: 0 } },
        '⚠ If sending fails with "account not registered" — click 🔐 Register phone above. WhatsApp Cloud API needs each number registered once with a PIN (use 000000 if you don\'t have 2FA on the number).')
    ));

    // ---- Webhook health card — surfaces the most common reason for
    //      "messages send but no delivered/read/inbound" (webhook not
    //      configured in Meta dashboard or not subscribed to fields).
    const whCard = h('div', { class: 'card', style: { borderLeft: '4px solid #f59e0b' } });
    whCard.appendChild(h('h4', { style: { marginTop: 0 } }, '📡 Webhook health'));
    const whBody = h('div', {}, h('div', { class: 'muted' }, 'Loading…'));
    whCard.appendChild(whBody);
    wrap.appendChild(whCard);
    api('api_wb_webhook_status', location.origin).then(w => {
      whBody.innerHTML = '';
      const isHealthy = (w.recent_count_24h > 0) && Array.isArray(w.subscribed) && w.subscribed.length > 0;
      whCard.style.borderLeftColor = isHealthy ? '#10b981' : '#f59e0b';
      // Top status line
      whBody.appendChild(h('div', { style: { fontSize: '.95rem', marginBottom: '.75rem' } },
        isHealthy
          ? h('span', {}, '✅ Webhook is receiving events from Meta. Last inbound: ', h('b', {}, fmtDate(w.last_inbound?.recorded_on, 'relative')), ' · ', w.recent_count_24h, ' events in last 24 h.')
          : h('span', {}, '⚠️ Webhook is not delivering events from Meta. ',
              w.recent_count_24h ? '' : 'Zero events in the last 24 h. ',
              'You won\'t see delivered / read / inbound messages until this is fixed.')
      ));
      // Setup checklist
      whBody.appendChild(h('div', { style: { background: '#f8fafc', padding: '.75rem 1rem', borderRadius: '6px', fontSize: '.85rem' } },
        h('div', { style: { fontWeight: 600, marginBottom: '.5rem' } }, '🔧 Webhook setup checklist'),
        h('ol', { style: { paddingLeft: '1.2rem', margin: 0 } },
          h('li', { style: { marginBottom: '.4rem' } },
            'In ', h('a', { href: 'https://developers.facebook.com/apps/' + (s.fb_app_id || ''), target: '_blank' }, 'Meta App Dashboard'),
            ' → Left sidebar → ', h('b', {}, 'WhatsApp → Configuration'), '. ',
            'Click ', h('b', {}, 'Edit'), ' next to Webhook.'
          ),
          h('li', { style: { marginBottom: '.4rem' } },
            'Callback URL — copy and paste: ',
            h('input', { value: w.webhook_url || (location.origin + '/hook/whatsapp_webhook'), readonly: 'readonly',
              style: { fontFamily: 'monospace', width: '100%', marginTop: '.25rem', padding: '.4rem', fontSize: '.78rem' },
              onclick: ev => { ev.target.select(); document.execCommand && document.execCommand('copy'); toast('Copied'); }
            })
          ),
          h('li', { style: { marginBottom: '.4rem' } },
            'Verify Token — paste this exactly: ',
            h('input', { value: w.verify_token || s.verify_token || '', readonly: 'readonly',
              style: { fontFamily: 'monospace', width: '100%', marginTop: '.25rem', padding: '.4rem', fontSize: '.78rem' },
              onclick: ev => { ev.target.select(); document.execCommand && document.execCommand('copy'); toast('Copied'); }
            })
          ),
          h('li', { style: { marginBottom: '.4rem' } },
            'Click ', h('b', {}, 'Verify and save'), ' in Meta — they\'ll ping our endpoint and confirm.'
          ),
          h('li', { style: { marginBottom: '.4rem' } },
            'Then in the same Webhook section, ', h('b', {}, 'Subscribe to fields'), ' — tick at least:',
            h('ul', { style: { margin: '.25rem 0' } },
              h('li', {}, h('code', {}, 'messages'), ' — required for inbound messages and status updates'),
              h('li', {}, h('code', {}, 'message_template_status_update'), ' — optional, for template approval changes')
            )
          ),
          h('li', {}, 'Click the ', h('b', {}, '🔄 Subscribe app'), ' button below to attach our app to the WABA (one-click).')
        )
      ));
      // Action row
      whBody.appendChild(h('div', { style: { marginTop: '.75rem', display: 'flex', gap: '.5rem', flexWrap: 'wrap' } },
        h('button', { class: 'btn primary', onclick: async () => {
          try { const r = await api('api_wb_webhook_subscribe'); toast('App subscribed to WABA'); showWbTab('connect'); }
          catch (e) { toast(e.message, 'err'); }
        } }, '🔄 Subscribe app to WABA'),
        h('button', { class: 'btn', onclick: () => showWbTab('activity') }, '📑 View Activity Log'),
        h('button', { class: 'btn ghost', onclick: () => showWbTab('connect') }, '🔄 Refresh status')
      ));
      // Subscribed apps detail
      if (w.subscribe_error) {
        whBody.appendChild(h('div', { class: 'error-box', style: { marginTop: '.5rem' } },
          'Could not check subscription: ', w.subscribe_error));
      } else if (Array.isArray(w.subscribed)) {
        whBody.appendChild(h('div', { class: 'muted', style: { fontSize: '.82rem', marginTop: '.5rem' } },
          w.subscribed.length === 0
            ? '⚠ No app is subscribed to this WABA. Click "Subscribe app to WABA" above.'
            : '✓ ' + w.subscribed.length + ' app(s) subscribed: ' + w.subscribed.map(a => a.app_name || a.app_id).join(', ')
        ));
      }
    }).catch(e => {
      whBody.innerHTML = '';
      whBody.appendChild(h('div', { class: 'error-box' }, 'Could not load webhook status: ' + e.message));
    });

    // ---- All WABA phone numbers — pulled live from /phone_numbers ----
    const phonesCard = h('div', { class: 'card' });
    phonesCard.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '.5rem' } },
      h('h4', { style: { margin: 0 } }, '📞 Phone Numbers on this WABA'),
      h('button', { class: 'btn sm ghost', onclick: () => showWbTab('connect') }, '🔄 Refresh')
    ));
    const phonesList = h('div', {}, h('div', { class: 'muted' }, 'Loading…'));
    phonesCard.appendChild(phonesList);
    wrap.appendChild(phonesCard);
    // Fire async so the rest of the page renders immediately
    api('api_wb_phones_list').then(rows => {
      phonesList.innerHTML = '';
      if (!rows.length) { phonesList.appendChild(h('p', { class: 'muted' }, 'No phone numbers found on this WABA.')); return; }
      const qColor = q => q === 'GREEN' ? '#10b981' : q === 'YELLOW' ? '#f59e0b' : q === 'RED' ? '#ef4444' : '#94a3b8';
      const sColor = s => /CONNECTED|VERIFIED/i.test(String(s)) ? '#10b981'
                     : /UNVERIFIED|PENDING/i.test(String(s)) ? '#f59e0b'
                     : /OFFLINE|FLAGGED|RESTRICTED/i.test(String(s)) ? '#ef4444'
                     : '#64748b';
      phonesList.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Number'),
          h('th', {}, 'Verified name'),
          h('th', {}, 'Quality'),
          h('th', {}, 'Status'),
          h('th', {}, 'Name approval'),
          h('th', {}, 'Tier'),
          h('th', {}, 'Phone ID'),
          h('th', {}, 'Actions')
        )),
        h('tbody', {}, ...rows.map(p => h('tr', {},
          h('td', {}, p.is_current ? h('b', {}, p.display_phone_number, ' ', h('span', { style: { color: '#3b82f6', fontSize: '.7rem' } }, '★ current')) : (p.display_phone_number || '—')),
          h('td', {}, p.verified_name || '—'),
          h('td', {}, h('span', { class: 'tag', style: { background: qColor(p.quality_rating), color: '#fff' } }, p.quality_rating || 'UNKNOWN')),
          h('td', {}, h('span', { class: 'tag', style: { background: sColor(p.status), color: '#fff' } }, p.status || 'UNKNOWN')),
          h('td', { class: 'muted', style: { fontSize: '.78rem' } }, p.name_status || '—'),
          h('td', { class: 'muted', style: { fontSize: '.78rem' } }, p.messaging_limit_tier || '—'),
          h('td', {}, h('code', { style: { fontSize: '.72rem' } }, p.id)),
          h('td', { style: { whiteSpace: 'nowrap' } },
            !p.is_current ? h('button', { class: 'btn sm', onclick: async () => {
              try { await api('api_wb_phones_set_current', p.id); toast('Switched to ' + p.display_phone_number); showWbTab('connect'); }
              catch (e) { toast(e.message, 'err'); }
            } }, '★ Use this') : null,
            h('button', { class: 'btn sm wa-cloud-btn', style: { marginLeft: '.25rem' },
              onclick: () => openRegisterPhoneModal(p.id)
            }, '🔐 Register')
          )
        )))
      )));
    }).catch(e => {
      phonesList.innerHTML = '';
      phonesList.appendChild(h('div', { class: 'error-box' }, 'Could not load phone numbers: ' + e.message));
    });
  }

  if (embOn) {
    // ============ EMBEDDED SIGNIN MODE ============
    // Already connected → don't show the Connect button again, just an
    // unobtrusive "Connect a different account" link at the bottom.
    if (isConnected) {
      const reconnectWrap = h('div', { style: { textAlign: 'center', marginTop: '1rem' } });
      reconnectWrap.appendChild(h('a', {
        href: '#', style: { fontSize: '.85rem', color: 'var(--text-muted, #64748b)' },
        onclick: ev => { ev.preventDefault();
          if (confirm('Connect a different WhatsApp Business account? Current connection will be replaced.')) {
            startEmbeddedSignup(s.fb_app_id, s.fb_config_id);
          }
        }
      }, 'Connect a different WhatsApp account'));
      wrap.appendChild(reconnectWrap);
      return wrap;
    }

    // Platform-managed Facebook credentials — clients never see App ID,
    // Secret or Config ID. They just click one button and pick their
    // WABA / phone number inside Meta's dialog.
    const introCard = h('div', { class: 'card wb-fb-card', style: { textAlign: 'center', padding: '2rem 1.5rem' } });
    introCard.appendChild(h('h3', { style: { marginTop: 0 } }, 'Connect your WhatsApp Business account'));
    introCard.appendChild(h('p', { class: 'muted', style: { maxWidth: '460px', margin: '.25rem auto 1.25rem' } },
      'Click the button below to link your WhatsApp Business Account. You\'ll be asked to log into Facebook, pick the business and phone number you want to use, and Meta will send everything back to us automatically — no API keys to copy or paste.'));
    introCard.appendChild(h('button', {
      class: 'btn-fb-meta',
      onclick: () => startEmbeddedSignup(s.fb_app_id, s.fb_config_id)
    },
      h('span', { class: 'fb-icon' }, '🅵'),
      ' Connect with Facebook'
    ));
    introCard.appendChild(h('p', { class: 'muted', style: { fontSize: '.78rem', marginTop: '1rem', marginBottom: 0 } },
      '🔒 You stay in control — Meta only shares the WABA and phone number you select.'));
    // Self-recovery: if the user already finished the dialog but the page
    // never refreshed, this re-fetches and reloads.
    introCard.appendChild(h('p', { style: { fontSize: '.8rem', marginTop: '.85rem', marginBottom: 0 } },
      h('a', { href: '#', style: { color: 'var(--text-muted, #64748b)' },
        onclick: ev => { ev.preventDefault(); location.reload(); }
      }, 'Already finished on Facebook? Click here to refresh status'),
    ));
    wrap.appendChild(introCard);
    return wrap;
  }

  // ============ MANUAL ENTRY MODE ============
  const manualCard = h('div', { class: 'card' });
  manualCard.appendChild(h('div', { class: 'wb-card-title' }, 'Manual WhatsApp credentials'));
  manualCard.appendChild(h('p', { class: 'muted', style: { marginTop: 0 } },
    'Paste WABA ID, Phone Number ID and Access Token directly. Use Embedded SignIn (toggle above) for the easier flow.'));
  const form = h('form', { class: 'form-grid', style: { marginTop: '.75rem' }, onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api('api_wb_settings_save', {
        waba_id: fd.get('waba_id'),
        access_token: fd.get('access_token') || undefined,
        phone_number_id: fd.get('phone_number_id'),
        verify_token: fd.get('verify_token'),
        autolead_on: !!fd.get('autolead_on'),
        autolead_source: fd.get('autolead_source'),
        default_user_id: fd.get('default_user_id'),
        default_status_id: fd.get('default_status_id'),
        default_country_code: fd.get('default_country_code') || '91'
      });
      toast('Settings saved'); showWbTab('connect');
    } catch (e) { toast(e.message, 'err'); }
  }});
  form.appendChild(field('waba_id', 'WhatsApp Business Account ID *', s.waba_id, { required: true }));
  form.appendChild(field('phone_number_id', 'Phone Number ID *', s.phone_number_id, { required: true }));
  form.appendChild(h('div', { class: 'f-row full' },
    h('label', {}, 'Access Token *',
      s.access_token_present ? h('span', { class: 'muted', style: { fontSize: '.75rem', marginLeft: '.4rem' } }, '(saved — leave blank to keep)') : null),
    h('input', { name: 'access_token', type: 'password', autocomplete: 'new-password',
      placeholder: s.access_token_present ? '••••••••••••••' : 'paste from Meta App → System Users → Generate Token' })
  ));
  form.appendChild(field('verify_token', 'Webhook Verify Token', s.verify_token));
  form.appendChild(h('div', { class: 'f-row full' },
    h('label', {}, 'Webhook callback URL (paste this into Meta → WhatsApp → Webhooks)'),
    h('input', { value: s.webhook_url, readonly: 'readonly',
      style: { background: '#f1f5f9', fontFamily: 'monospace' },
      onclick: ev => ev.target.select() })
  ));
  form.appendChild(h('h4', { style: { gridColumn: '1 / -1', marginTop: '1rem' } }, 'Auto-lead from inbound message'));
  form.appendChild(h('div', { class: 'f-row' },
    h('label', {}, 'Convert new messages to leads'),
    h('label', { class: 'qual-toggle' },
      h('input', { type: 'checkbox', name: 'autolead_on', checked: s.autolead_on ? 'checked' : null }),
      ' Enabled')
  ));
  form.appendChild(field('autolead_source', 'Lead source (when auto-creating)', s.autolead_source || 'WhatsApp'));
  form.appendChild(field('default_country_code', 'Default country code (for 10-digit numbers)', s.default_country_code || '91'));
  // Lead defaults pickers
  const users = CRM.cache.users || [];
  const statuses = CRM.cache.statuses || [];
  form.appendChild(selectField('default_user_id', 'Default assignee for new WhatsApp leads', s.default_user_id,
    [{ value: '', label: '— Use assignment rules —' }, ...users.map(u => ({ value: u.id, label: u.name }))]));
  form.appendChild(selectField('default_status_id', 'Default status for new WhatsApp leads', s.default_status_id,
    [{ value: '', label: '— First status —' }, ...statuses.map(st => ({ value: st.id, label: st.name }))]));
  form.appendChild(h('div', { class: 'f-row full' },
    h('button', { type: 'submit', class: 'btn primary' }, '💾 Save settings')
  ));
  manualCard.appendChild(form);
  wrap.appendChild(manualCard);
  return wrap;
}

/**
 * Register the WABA phone number with Meta's Cloud API. This is a
 * one-time post-connect step required before any /messages call works.
 * Without it Meta returns "account is not registered" (error 133010).
 *
 * If the number doesn't have two-factor PIN set, leave the input as
 * 000000. If it does, the user must paste the 6-digit PIN they configured
 * when first claiming the number on whatsapp.com / Business Manager.
 */
/**
 * Push a "call this number" notification to the user's logged-in mobile
 * device(s). When they tap the notification, the APK opens our /#/dial
 * route which auto-fires `tel:` and launches the native dialer with the
 * number pre-filled. They just press the green call button on their phone.
 *
 * Requires the FCM Android APK to be installed and logged in as the same
 * user — desktop and mobile share the same user account.
 */
async function callViaMobile(lead) {
  const phone = String(lead?.phone || '').trim();
  if (!phone) { toast('Lead has no phone number', 'err'); return; }
  // Auto-prepend India country code if it's a 10-digit mobile, so the
  // dialer opens with a directly-callable number.
  let normalized = phone.replace(/\D/g, '');
  if (normalized.length === 10 && /^[6-9]/.test(normalized)) normalized = '91' + normalized;
  const dial = '+' + normalized;
  try {
    const r = await api('api_call_via_mobile', lead?.id || null, dial, lead?.name || '');
    const fcmCount = (r.push && r.push.fcm && r.push.fcm.sent) || 0;
    if (fcmCount === 0) {
      toast('No mobile device registered for push. Install the Android app + log in, then try again.', 'warn');
    } else {
      toast('📱 Sent to your phone — tap the notification to open the dialer.');
    }
  } catch (e) { toast(e.message, 'err'); }
}

/**
 * Send a Calendly meeting link via WhatsApp.
 *
 * Reads the rep's calendly_url from CRM.user (set by api_me at login).
 * If unset, prompts the rep to paste it in their profile first. Otherwise
 * opens wa.me with a pre-filled message including the lead's name and
 * the booking URL — the rep just hits Send.
 *
 * Phase 2 will add a Calendly webhook that auto-creates a follow-up in
 * CRM the moment the prospect picks a slot.
 */
function sendCalendlyLink(lead) {
  const url = (CRM.user && CRM.user.calendly_url) || '';
  if (!url) {
    toast('Set your Calendly link in My Profile (top-right avatar → Edit profile) first.', 'warn');
    return;
  }
  const phone = String(lead?.phone || '').replace(/\D/g, '');
  if (!phone) { toast('Lead has no phone number', 'err'); return; }
  const dial = phone.length === 10 && /^[6-9]/.test(phone) ? '91' + phone : phone;
  const name = (lead?.name || 'there').split(/\s+/)[0]; // first name only
  const me = (CRM.user && CRM.user.name) ? (' — ' + CRM.user.name) : '';
  const text = `Hi ${name}, please pick a time that works for a quick call: ${url}${me}`;
  const waUrl = 'https://wa.me/' + dial + '?text=' + encodeURIComponent(text);
  // Best-effort: log a remark so the team knows a meeting link went out.
  try { api('api_leads_addRemark', lead.id, { remark: '📅 Calendly meeting link sent via WhatsApp' }).catch(() => {}); } catch (_) {}
  window.open(waUrl, '_blank');
}

/**
 * Substitute {placeholders} in a personal WA template body with values
 * from the lead and current user. Unknown tokens are left in place so
 * the rep can spot mistakes.
 */
function _renderPersonalWaTemplate(body, lead) {
  const me = CRM.user || {};
  const ctx = {
    name:        lead?.name || '',
    first_name:  String(lead?.name || '').split(/\s+/)[0],
    phone:       lead?.phone || '',
    company:     lead?.company || '',
    value:       lead?.value ? '₹' + Number(lead.value).toLocaleString('en-IN') : '',
    next_followup: lead?.next_followup_at ? new Date(lead.next_followup_at).toLocaleString('en-IN') : '',
    my_name:     me.name || '',
    calendly:    me.calendly_url || ''
  };
  return String(body || '').replace(/\{(\w+)\}/g, (m, k) => ctx[k] != null ? ctx[k] : m);
}

/**
 * 💬 personal WhatsApp picker — opens a small modal with the rep's
 * saved templates. Picking one substitutes lead/user placeholders and
 * launches wa.me with the full message pre-filled. Includes a
 * "Blank — just open chat" shortcut and a "Manage templates" link.
 */
async function openPersonalWaPicker(lead) {
  const phone = String(lead?.phone || '').replace(/\D/g, '');
  if (!phone) { toast('Lead has no phone number', 'err'); return; }
  const dial = phone.length === 10 && /^[6-9]/.test(phone) ? '91' + phone : phone;

  let templates = [];
  try { templates = await api('api_personalWa_list'); } catch (_) {}

  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } });
  const launch = (text) => {
    const url = 'https://wa.me/' + dial + (text ? '?text=' + encodeURIComponent(text) : '');
    try { if (lead?.id) api('api_leads_addRemark', lead.id, { remark: '💬 WhatsApp sent (personal): ' + (text || '(blank chat opened)').slice(0, 200) }).catch(() => {}); } catch (_) {}
    window.open(url, '_blank');
    modal.remove();
  };
  const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '.4rem', maxHeight: '50vh', overflowY: 'auto' } });
  if (!templates.length) {
    list.appendChild(h('p', { class: 'muted', style: { margin: 0, fontSize: '.88rem' } },
      'No personal WhatsApp templates yet. Click "Manage templates" below to create your first — it saves typing on every chat.'));
  }
  templates.forEach(t => {
    const rendered = _renderPersonalWaTemplate(t.body, lead);
    list.appendChild(h('div', {
      class: 'card', style: { padding: '.6rem .8rem', cursor: 'pointer', borderLeft: '3px solid #25D366' },
      onclick: () => launch(rendered)
    },
      h('div', { style: { fontWeight: 600, marginBottom: '.2rem' } }, t.name),
      h('div', { class: 'muted', style: { fontSize: '.8rem', whiteSpace: 'pre-wrap' } },
        rendered.length > 180 ? rendered.slice(0, 180) + '…' : rendered)
    ));
  });
  modal.appendChild(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' },
      h('h3', {}, '💬 Send WhatsApp from your number'),
      h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
    ),
    h('p', { class: 'muted', style: { fontSize: '.8rem', margin: '0 0 .75rem' } },
      'Pick a template — WhatsApp opens with the message pre-filled, you tap Send. WhatsApp doesn\'t allow third-party apps to send silently from a personal number; if you need automated sending, use the 🟢 WA Template button (Cloud API, business number).'),
    list,
    h('div', { class: 'actions', style: { marginTop: '.75rem', flexWrap: 'wrap', gap: '.4rem' } },
      h('button', { class: 'btn', onclick: () => launch('') }, 'Open blank chat'),
      h('button', { class: 'btn primary', onclick: () => { modal.remove(); openPersonalWaTemplatesModal(); } }, '✎ Manage templates')
    )
  ));
  document.body.appendChild(modal);
}

/**
 * CRUD modal for the rep's personal WhatsApp templates. Per-user.
 * Body supports placeholders documented in the help text.
 */
async function openPersonalWaTemplatesModal() {
  let templates = [];
  try { templates = await api('api_personalWa_list'); } catch (_) {}
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } });
  const listWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '.5rem', maxHeight: '50vh', overflowY: 'auto', marginBottom: '1rem' } });
  const renderList = () => {
    listWrap.innerHTML = '';
    if (!templates.length) {
      listWrap.appendChild(h('p', { class: 'muted', style: { margin: 0 } }, 'No templates yet — add your first below.'));
    }
    templates.forEach(t => {
      listWrap.appendChild(h('div', { class: 'card', style: { padding: '.6rem .8rem' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem' } },
          h('strong', { style: { flex: 1 } }, t.name),
          h('button', { class: 'btn sm', onclick: () => editOne(t) }, '✎'),
          h('button', { class: 'btn sm danger', onclick: async () => {
            if (!await confirmDialog('Delete "' + t.name + '"?')) return;
            try { await api('api_personalWa_delete', t.id); toast('Deleted'); templates = await api('api_personalWa_list'); renderList(); }
            catch (e) { toast(e.message, 'err'); }
          } }, '🗑')
        ),
        h('div', { class: 'muted', style: { fontSize: '.78rem', whiteSpace: 'pre-wrap', marginTop: '.25rem' } }, t.body)
      ));
    });
  };
  const editOne = (t) => {
    t = t || { name: '', body: '' };
    const formModal = h('div', { class: 'modal-backdrop', style: { zIndex: 9999 }, onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) formModal.remove(); } },
      h('div', { class: 'modal' },
        h('div', { class: 'modal-head' },
          h('h3', {}, t.id ? 'Edit template' : '+ New template'),
          h('button', { class: 'btn icon', onclick: () => formModal.remove() }, '✕')
        ),
        h('form', { id: 'pwa-tpl-form', class: 'form-grid' },
          h('div', { class: 'f-row full' },
            h('label', {}, 'Template name'),
            h('input', { name: 'name', value: t.name, placeholder: 'e.g. Site visit reminder', required: 'required' })
          ),
          h('div', { class: 'f-row full' },
            h('label', {}, 'Message body'),
            h('textarea', { name: 'body', rows: 6, placeholder: 'Hi {first_name}, this is {my_name} from Adbullet — just confirming our site visit tomorrow at 11 AM. Reply YES to confirm.' }, t.body || '')
          ),
          h('div', { class: 'f-row full' },
            h('p', { class: 'muted', style: { margin: 0, fontSize: '.78rem' } },
              'Placeholders auto-fill when you send: ',
              h('code', {}, '{name}'), ', ', h('code', {}, '{first_name}'), ', ',
              h('code', {}, '{phone}'), ', ', h('code', {}, '{company}'), ', ',
              h('code', {}, '{value}'), ', ', h('code', {}, '{next_followup}'), ', ',
              h('code', {}, '{my_name}'), ', ', h('code', {}, '{calendly}'))
          )
        ),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => formModal.remove() }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: async () => {
            const f = $('#pwa-tpl-form');
            const fd = new FormData(f);
            const payload = { id: t.id, name: fd.get('name'), body: fd.get('body') };
            if (!payload.name || !payload.body) return toast('Name and body required', 'err');
            try { await api('api_personalWa_save', payload); toast('Saved'); formModal.remove(); templates = await api('api_personalWa_list'); renderList(); }
            catch (e) { toast(e.message, 'err'); }
          } }, 'Save')
        )
      )
    );
    document.body.appendChild(formModal);
  };
  modal.appendChild(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' },
      h('h3', {}, '💬 My WhatsApp templates'),
      h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
    ),
    listWrap,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => editOne(null) }, '+ New template')
    )
  ));
  document.body.appendChild(modal);
  renderList();
}

function openRegisterPhoneModal(phoneIdOverride) {
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal' });
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, '🔐 Register phone with Cloud API'),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));
  body.appendChild(h('p', { class: 'muted' },
    'WhatsApp Cloud API requires each phone number to be registered ONCE before it can send messages. ',
    'If two-step verification is OFF for this number, leave the PIN as ', h('code', {}, '000000'), '. ',
    'If 2FA is ON, paste the 6-digit PIN you set on the WhatsApp app or Meta Business Manager.'));
  if (phoneIdOverride) {
    body.appendChild(h('p', { class: 'muted', style: { fontSize: '.8rem' } },
      'Registering phone ID ', h('code', {}, phoneIdOverride)));
  }
  const pinInput = h('input', {
    type: 'text', value: '000000', maxLength: 6,
    style: { fontFamily: 'monospace', fontSize: '1.2rem', textAlign: 'center', letterSpacing: '.5rem' }
  });
  body.appendChild(h('div', { class: 'f-row full' },
    h('label', {}, '6-digit PIN'),
    pinInput
  ));
  body.appendChild(h('div', { class: 'actions', style: { marginTop: '1rem' } },
    h('button', { class: 'btn', onclick: () => m.remove() }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        const pin = String(pinInput.value || '000000').replace(/\D/g, '').slice(0, 6) || '000000';
        await api('api_wb_register_phone', pin, phoneIdOverride || undefined);
        toast('✅ Phone registered with Cloud API. Try sending again.');
        m.remove();
      } catch (e) { toast(e.message, 'err'); }
    } }, 'Register')
  ));
  m.appendChild(body);
  document.body.appendChild(m);
}

/**
 * Embedded Signup launcher. Loads the Facebook JS SDK, calls FB.login with
 * the WhatsApp config_id and Embedded Signup `extras`, and listens for the
 * postMessage events that carry phone_number_id + waba_id while the user
 * goes through the dialog. When the user clicks Finish, we have all three:
 *   - the OAuth code (from FB.login callback)
 *   - phone_number_id + waba_id (from the postMessage WA_EMBEDDED_SIGNUP event)
 * → POST those to /api → server exchanges the code for an access token and
 * persists everything. Page reloads to show the connected state.
 */
function startEmbeddedSignup(appId, configId) {
  if (!appId || !configId) { toast('App ID + Config ID required', 'err'); return; }
  // Hot path — SDK already preloaded by wbConnect(). Calling FB.login
  // synchronously inside the click handler is critical or Chrome blocks
  // the popup as a "non-user-initiated" window.open.
  if (!(window.FB && typeof window.FB.login === 'function')) {
    toast('Loading Facebook SDK… please click "Connect with Facebook" again in 2 seconds.', 'warn');
    ensureFbSdkLoaded(appId).then(() => {
      toast('Facebook SDK ready — click Connect with Facebook now.');
    }).catch(e => toast(e.message, 'err'));
    return;
  }

  let phoneNumberId = '';
  let wabaId = '';
  // PostMessage listener — Meta sends phone_number_id + waba_id during the
  // dialog when the user clicks "Finish". Without this, we get the OAuth
  // code but don't know which assets they picked.
  const sessionInfoListener = (event) => {
    if (event.origin !== 'https://www.facebook.com') return;
    try {
      const data = (typeof event.data === 'string') ? JSON.parse(event.data) : event.data;
      if (data && data.type === 'WA_EMBEDDED_SIGNUP' && data.event === 'FINISH') {
        phoneNumberId = data.data?.phone_number_id || '';
        wabaId       = data.data?.waba_id || '';
      }
    } catch (_) { /* not JSON, ignore */ }
  };
  window.addEventListener('message', sessionInfoListener);

  toast('Opening Facebook…');
  // Track if we ever got a postMessage from facebook.com — if not after 12s,
  // the popup is likely being instantly closed by Facebook because the
  // redirect URI isn't whitelisted in the app's OAuth settings.
  let _gotMessage = false;
  const _origListener = sessionInfoListener;
  const wrapped = (event) => { if (event.origin === 'https://www.facebook.com') _gotMessage = true; _origListener(event); };
  window.removeEventListener('message', _origListener);
  window.addEventListener('message', wrapped);
  // The FB SDK rejects async functions as callbacks with the error
  // 'Expression is of type asyncfunction, not function'. Use a regular
  // function and wrap the body in an async IIFE so we can still await
  // the api() call inside.
  FB.login(function (response) {
    window.removeEventListener('message', wrapped);
    if (!response || !response.authResponse) {
      if (!_gotMessage) {
        toast('Facebook rejected the popup. Add "' + location.origin + '/" to Valid OAuth Redirect URIs in your Meta App → Facebook Login for Business → Settings, then save and try again.', 'err');
      } else {
        toast('Login cancelled by user.', 'warn');
      }
      return;
    }
    const code = response.authResponse.code;
    if (!code) {
      toast('No authorization code returned by Facebook.', 'err');
      return;
    }
    if (!phoneNumberId || !wabaId) {
      toast('Did not receive WABA / phone number from the dialog. Check the Config ID has WhatsApp Business Platform asset selection enabled.', 'err');
      return;
    }
    (async () => {
      try {
        toast('Exchanging credentials with Meta…');
        const r = await api('api_wb_emb_signin', code, phoneNumberId, wabaId);
        let msg = `✅ Connected (WABA ${r.waba_id}, Phone ${r.phone_number_id})`;
        if (r.templates_synced > 0) msg += ` · ${r.templates_synced} templates synced`;
        if (!r.subscribed && r.subscribe_error) msg += ` · ⚠ webhook subscribe failed: ${r.subscribe_error}`;
        toast(msg);
        // Hard reload so the post-connect cards (banner / webhook / phones)
        // render with a fully fresh fetch — a tab re-render alone has been
        // observed to occasionally miss the freshly-saved config rows.
        setTimeout(() => { location.hash = '#/whatsbot/connect'; location.reload(); }, 800);
      } catch (e) { toast(e.message, 'err'); }
    })();
  }, {
    config_id: configId,
    response_type: 'code',
    override_default_response_type: true,
    extras: {
      setup: {},
      featureType: '',
      sessionInfoVersion: '2'
    }
  });
}

// ---------- Templates ----------
async function wbTemplates() {
  const wrap = h('div', {});
  const list = await api('api_wb_templates_list').catch(() => []);
  // Template creation/edit/submission lives on the Meta side — this CRM
  // can only consume APPROVED templates. We expose a one-click jump-off
  // to Meta's Template Manager so admins don't have to hunt for the URL.
  wrap.appendChild(h('div', { class: 'toolbar' },
    h('h3', { style: { margin: 0, flex: 1 } }, '📋 Templates (' + list.length + ')'),
    h('a', {
      class: 'btn',
      href: 'https://business.facebook.com/wa/manage/message-templates/',
      target: '_blank', rel: 'noopener',
      title: 'Open Meta Business — create / edit / submit WhatsApp templates'
    }, '🛠 Template Management ↗'),
    h('button', { class: 'btn primary', style: { marginLeft: '.4rem' }, onclick: async () => {
      try { const r = await api('api_wb_templates_sync'); toast('Synced ' + r.count + ' templates'); showWbTab('templates'); }
      catch (e) { toast(e.message, 'err'); }
    } }, '🔄 Sync from Meta')
  ));
  wrap.appendChild(h('p', { class: 'muted', style: { fontSize: '.82rem', margin: '0 0 .75rem' } },
    'Need a new template, edits to an existing one, or to check approval status? Open ',
    h('b', {}, 'Template Management'),
    ' to manage them in Meta Business Manager, then come back and click ',
    h('b', {}, 'Sync from Meta'),
    ' to refresh this list.'
  ));
  if (!list.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No templates yet. Click "Sync from Meta" to pull your approved templates.'));
    return wrap;
  }
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Lang'), h('th', {}, 'Category'),
      h('th', {}, 'Status'), h('th', {}, 'Body params'), h('th', {}, 'Body preview'))),
    h('tbody', {}, ...list.map(t => h('tr', {},
      h('td', {}, h('code', {}, t.name)),
      h('td', {}, t.language),
      h('td', {}, t.category || '—'),
      h('td', {},
        h('span', { class: t.status === 'APPROVED' ? 'tag' : 'tag err',
          style: t.status === 'APPROVED' ? { background: '#10b981', color: '#fff' } : null
        }, t.status)
      ),
      h('td', {}, t.body_params),
      h('td', { style: { maxWidth: '420px' }, title: t.body_text || '' }, (t.body_text || '').slice(0, 100) + ((t.body_text || '').length > 100 ? '…' : ''))
    )))
  )));
  return wrap;
}

// ---------- Message Bot ----------
async function wbMessageBots() {
  const wrap = h('div', {});
  const bots = await api('api_wb_message_bots_list').catch(() => []);
  wrap.appendChild(h('div', { class: 'toolbar' },
    h('h3', { style: { margin: 0, flex: 1 } }, '💬 Message Bots'),
    h('button', { class: 'btn primary', onclick: () => openMsgBotModal() }, '+ New bot')
  ));
  if (!bots.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No message bots yet. Create one to auto-reply when a contact sends a keyword.'));
    return wrap;
  }
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Trigger'), h('th', {}, 'Match'),
      h('th', {}, 'Reply'), h('th', {}, 'Active'), h('th', {}, ''))),
    h('tbody', {}, ...bots.map(b => h('tr', {},
      h('td', {}, b.name),
      h('td', {}, h('code', {}, b.trigger_text)),
      h('td', {}, b.reply_type),
      h('td', { style: { maxWidth: '320px' }, title: b.reply_text }, String(b.reply_text || '').slice(0, 80) + (String(b.reply_text || '').length > 80 ? '…' : '')),
      h('td', {}, Number(b.is_active) === 1 ? '✓' : '—'),
      h('td', {},
        h('button', { class: 'btn sm', onclick: () => openMsgBotModal(b) }, '✎'),
        h('button', { class: 'btn sm ghost danger', style: { marginLeft: '.25rem' }, onclick: async () => {
          if (!await confirmDialog('Delete bot "' + b.name + '"?')) return;
          await api('api_wb_message_bots_delete', b.id); toast('Deleted'); showWbTab('msgbots');
        } }, '🗑️')
      )
    )))
  )));
  return wrap;
}

function openMsgBotModal(bot) {
  const b = bot || {};
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, b.id ? 'Edit message bot' : 'New message bot'),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));
  const form = h('form', { class: 'form-grid' });
  form.appendChild(field('name', 'Bot Name *', b.name, { required: true }));
  form.appendChild(selectField('relation_type', 'Relation Type', b.relation_type || 'leads', [{ value: 'leads', label: 'Leads' }]));
  form.appendChild(h('div', { class: 'f-row full' }, h('label', {}, 'Reply text *'),
    h('textarea', { name: 'reply_text', rows: 5, required: true }, b.reply_text || '')));
  form.appendChild(selectField('reply_type', 'Reply type', b.reply_type || 'contains', [
    { value: 'contains', label: 'Reply bot: When message contains' },
    { value: 'exact', label: 'Reply bot: On exact match' }
  ]));
  form.appendChild(field('trigger_text', 'Trigger keywords (comma-separated) *', b.trigger_text, { required: true }));
  form.appendChild(field('header', 'Header (optional)', b.header));
  form.appendChild(field('footer', 'Footer (optional)', b.footer));
  form.appendChild(h('div', { class: 'f-row' },
    h('label', {}, 'Active'),
    h('label', { class: 'qual-toggle' },
      h('input', { type: 'checkbox', name: 'is_active', checked: (b.id && Number(b.is_active) === 0) ? null : 'checked' }),
      ' Enabled')
  ));
  body.appendChild(form);
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: () => m.remove() }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      const fd = new FormData(form);
      try {
        await api('api_wb_message_bots_save', {
          id: b.id || undefined,
          name: fd.get('name'), relation_type: fd.get('relation_type'),
          reply_text: fd.get('reply_text'), reply_type: fd.get('reply_type'),
          trigger_text: fd.get('trigger_text'),
          header: fd.get('header'), footer: fd.get('footer'),
          is_active: fd.get('is_active') ? 1 : 0
        });
        toast('Saved'); m.remove(); showWbTab('msgbots');
      } catch (e) { toast(e.message, 'err'); }
    } }, 'Save bot')
  ));
  m.appendChild(body);
  document.body.appendChild(m);
}

// ---------- Template Bot ----------
async function wbTemplateBots() {
  const wrap = h('div', {});
  const [bots, templates] = await Promise.all([api('api_wb_template_bots_list'), api('api_wb_templates_list')]);
  wrap.appendChild(h('div', { class: 'toolbar' },
    h('h3', { style: { margin: 0, flex: 1 } }, '🤖 Template Bots'),
    h('button', { class: 'btn primary', onclick: () => openTplBotModal(null, templates) }, '+ New bot')
  ));
  if (!bots.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No template bots. Create one to auto-reply with an approved template.'));
    return wrap;
  }
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Trigger'), h('th', {}, 'Template'), h('th', {}, 'Active'), h('th', {}, ''))),
    h('tbody', {}, ...bots.map(b => h('tr', {},
      h('td', {}, b.name),
      h('td', {}, h('code', {}, b.trigger_text)),
      h('td', {}, h('code', {}, b.template_name)),
      h('td', {}, Number(b.is_active) === 1 ? '✓' : '—'),
      h('td', {},
        h('button', { class: 'btn sm', onclick: () => openTplBotModal(b, templates) }, '✎'),
        h('button', { class: 'btn sm ghost danger', style: { marginLeft: '.25rem' }, onclick: async () => {
          if (!await confirmDialog('Delete bot "' + b.name + '"?')) return;
          await api('api_wb_template_bots_delete', b.id); toast('Deleted'); showWbTab('tplbots');
        } }, '🗑️')
      )
    )))
  )));
  return wrap;
}

function openTplBotModal(bot, templates) {
  const b = bot || {};
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, b.id ? 'Edit template bot' : 'New template bot'),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));
  const form = h('form', { class: 'form-grid' });
  form.appendChild(field('name', 'Bot Name *', b.name, { required: true }));
  form.appendChild(selectField('relation_type', 'Relation Type', b.relation_type || 'leads', [{ value: 'leads', label: 'Leads' }]));
  // Template picker — only approved
  const approved = (templates || []).filter(t => t.status === 'APPROVED');
  const tplOpts = approved.map(t => ({ value: t.name + '||' + t.language, label: t.name + ' (' + t.language + ')' }));
  const initialTpl = b.template_name ? (b.template_name + '||' + (b.template_language || 'en_US')) : '';
  form.appendChild(selectField('template_combo', 'Template *', initialTpl,
    [{ value: '', label: '— pick a template —' }, ...tplOpts], { full: true }));
  // Variables — generate inputs based on selected template's body_params
  const varsContainer = h('div', { class: 'f-row full', id: 'wb-var-container' });
  form.appendChild(varsContainer);
  function renderVars(combo) {
    const [name, lang] = String(combo || '').split('||');
    const t = approved.find(x => x.name === name && x.language === lang);
    varsContainer.innerHTML = '';
    if (!t || !t.body_params) return;
    varsContainer.appendChild(h('label', {}, 'Variables (use @{name}, @{phone}, etc.)'));
    const existing = (b.variables_json && (typeof b.variables_json === 'string' ? safeJson_(b.variables_json) : b.variables_json)) || [];
    for (let i = 0; i < t.body_params; i++) {
      varsContainer.appendChild(h('input', {
        name: 'var_' + i,
        placeholder: 'V' + (i + 1),
        value: existing[i] || ''
      }));
    }
  }
  form.querySelector('[name="template_combo"]')?.addEventListener('change', ev => renderVars(ev.target.value));
  setTimeout(() => renderVars(initialTpl), 50);
  form.appendChild(selectField('reply_type', 'Reply type', b.reply_type || 'exact', [
    { value: 'exact', label: 'Reply bot: On exact match' },
    { value: 'contains', label: 'Reply bot: When message contains' }
  ]));
  form.appendChild(field('trigger_text', 'Trigger keywords (comma-separated) *', b.trigger_text, { required: true }));
  form.appendChild(h('div', { class: 'f-row' },
    h('label', {}, 'Active'),
    h('label', { class: 'qual-toggle' },
      h('input', { type: 'checkbox', name: 'is_active', checked: (b.id && Number(b.is_active) === 0) ? null : 'checked' }),
      ' Enabled')
  ));
  body.appendChild(form);
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: () => m.remove() }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      const combo = form.querySelector('[name="template_combo"]').value;
      const [name, lang] = combo.split('||');
      if (!name) { toast('Pick a template', 'err'); return; }
      const variables = [];
      [...form.querySelectorAll('input[name^="var_"]')].forEach(i => variables.push(i.value));
      try {
        await api('api_wb_template_bots_save', {
          id: b.id || undefined,
          name: form.name.value, relation_type: form.relation_type.value,
          template_name: name, template_language: lang || 'en_US',
          variables, reply_type: form.reply_type.value,
          trigger_text: form.trigger_text.value,
          is_active: form.is_active.checked ? 1 : 0
        });
        toast('Saved'); m.remove(); showWbTab('tplbots');
      } catch (e) { toast(e.message, 'err'); }
    } }, 'Save bot')
  ));
  m.appendChild(body);
  document.body.appendChild(m);
}
function safeJson_(s) { try { return JSON.parse(s); } catch (_) { return []; } }

// ---------- Campaigns ----------
async function wbCampaigns() {
  const wrap = h('div', {});
  const [campaigns, templates] = await Promise.all([api('api_wb_campaigns_list'), api('api_wb_templates_list')]);
  wrap.appendChild(h('div', { class: 'toolbar' },
    h('h3', { style: { margin: 0, flex: 1 } }, '📣 Campaigns'),
    h('button', { class: 'btn primary', onclick: () => openCampaignModal(templates) }, '+ Send new campaign')
  ));
  if (!campaigns.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No campaigns yet.'));
    return wrap;
  }
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Template'), h('th', {}, 'Recipients'),
      h('th', {}, 'Sent'), h('th', {}, 'Delivered'), h('th', {}, 'Read'), h('th', {}, 'Failed'),
      h('th', {}, 'Status'), h('th', {}, 'Created'), h('th', {}, ''))),
    h('tbody', {}, ...campaigns.map(c => h('tr', {},
      h('td', {}, c.name),
      h('td', {}, h('code', {}, c.template_name)),
      h('td', {}, c.recipients_total),
      h('td', {}, c.recipients_sent),
      h('td', {}, c.recipients_delivered),
      h('td', {}, c.recipients_read),
      h('td', {}, c.recipients_failed),
      h('td', {}, h('span', { class: 'tag', style: { background: c.status === 'completed' ? '#10b981' : c.status === 'sending' ? '#6366f1' : c.status === 'failed' ? '#ef4444' : '#64748b', color: '#fff' } }, c.status)),
      h('td', { class: 'muted' }, fmtDate(c.created_at, 'relative')),
      h('td', {},
        c.status === 'draft' || c.status === 'paused'
          ? h('button', { class: 'btn sm primary', onclick: async () => {
              try { await api('api_wb_campaigns_send_now', c.id); toast('Sending…'); showWbTab('campaigns'); }
              catch (e) { toast(e.message, 'err'); }
            } }, '▶ Send')
          : c.status === 'sending'
          ? h('button', { class: 'btn sm ghost', onclick: async () => {
              try { await api('api_wb_campaigns_pause', c.id); toast('Paused'); showWbTab('campaigns'); }
              catch (e) { toast(e.message, 'err'); }
            } }, '⏸ Pause')
          : null
      )
    )))
  )));
  return wrap;
}

/**
 * Initiate Chat — sends an approved template to a single lead via the
 * green WhatsApp icon in the leads list.
 *
 * Layout:
 *   - Top: Template picker dropdown (only APPROVED templates).
 *   - Left card: Variables — one input per body_param, with @{merge}
 *     hints. If the template has no variables, shows "no variables".
 *   - Right card: Live preview of the template body with {{N}} swapped
 *     for the user's input AS THEY TYPE.
 *   - Bottom: Cancel / Send.
 *
 * On send, calls api_wb_initiate_chat which renders @{name}, @{phone},
 * etc. against the lead row, persists the message, and surfaces any
 * Meta error in a toast. Status / read receipts arrive via webhook
 * and update the chat thread automatically.
 */
async function openInitiateChatModal(lead) {
  // Lazy-load the templates cache
  let templates = CRM.cache.waTemplates;
  if (!templates) {
    try { templates = await api('api_wb_templates_list'); CRM.cache.waTemplates = templates; }
    catch (e) { toast('Could not load templates: ' + e.message, 'err'); return; }
  }
  const approved = (templates || []).filter(t => t.status === 'APPROVED');
  if (!approved.length) {
    toast('No approved templates yet. Settings → WhatsBot → Templates → Sync from Meta.', 'warn');
    return;
  }
  const phone = String(lead?.phone || lead?.whatsapp || '').replace(/\D/g, '');
  if (!phone) { toast('Lead has no phone number', 'err'); return; }

  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, 'Initiate Chat'),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));
  // Show the actual phone number we'll send to (E.164) and any
  // normalisation warning. Catches the most common "single tick but
  // never delivered" case where the lead's stored phone is just
  // 10 digits without a country code.
  const phoneInfoBox = h('div', { class: 'muted', style: { padding: '.35rem .65rem', background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: '6px', marginBottom: '.75rem', fontSize: '.82rem' } }, 'Resolving phone…');
  body.appendChild(phoneInfoBox);
  api('api_wb_phone_check', phone).then(r => {
    phoneInfoBox.style.background = r.looks_ok ? '#dcfce7' : '#fef2f2';
    phoneInfoBox.style.borderColor = r.looks_ok ? '#22c55e' : '#ef4444';
    phoneInfoBox.innerHTML = '';
    phoneInfoBox.appendChild(h('span', {}, '📞 Will send to: ',
      h('b', { style: { fontFamily: 'monospace' } }, '+' + r.normalised),
      r.original && r.original.replace(/\D/g, '') !== r.normalised
        ? h('span', { class: 'muted', style: { marginLeft: '.5rem', fontSize: '.78rem' } }, '(was: ' + r.original + ')')
        : null
    ));
    if (r.issues && r.issues.length) {
      r.issues.forEach(i => {
        phoneInfoBox.appendChild(h('div', { style: { fontSize: '.78rem', marginTop: '.2rem' } }, '• ' + i));
      });
    }
  }).catch(() => { phoneInfoBox.style.display = 'none'; });

  // Template picker
  const tplSel = h('select', {},
    h('option', { value: '' }, '— pick a template —'),
    ...approved.map(t => h('option', { value: t.name + '||' + t.language }, t.name + ' (' + t.language + ')'))
  );
  const tplRow = h('div', { class: 'f-row full' },
    h('label', {}, 'Template'),
    tplSel
  );
  body.appendChild(h('form', { class: 'form-grid' }, tplRow));

  // Two-column body: variables (left) + preview (right)
  const cols = h('div', { class: 'init-chat-grid' });
  const varsCol = h('div', { class: 'card' });
  varsCol.appendChild(h('div', { class: 'init-chat-col-head' }, 'Variables ',
    h('span', { class: 'muted', style: { fontWeight: 'normal', fontSize: '.78rem' } }, "Use '@' Sign for add merge fields.")));
  const varsBody = h('div', { class: 'init-chat-vars' });
  varsCol.appendChild(varsBody);

  const previewCol = h('div', { class: 'card' });
  previewCol.appendChild(h('div', { class: 'init-chat-col-head' }, 'Preview'));
  const previewBox = h('div', { class: 'init-chat-preview' }, h('div', { class: 'muted', style: { textAlign: 'center', padding: '2rem' } }, 'Pick a template above…'));
  previewCol.appendChild(previewBox);

  cols.appendChild(varsCol);
  cols.appendChild(previewCol);
  body.appendChild(cols);

  // Footer
  const sendBtn = h('button', { class: 'btn primary', disabled: 'disabled' }, 'Send');
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: () => m.remove() }, 'Close'),
    sendBtn
  ));
  m.appendChild(body);
  document.body.appendChild(m);

  let currentTpl = null;
  function refreshPreview() {
    if (!currentTpl) {
      previewBox.innerHTML = '';
      previewBox.appendChild(h('div', { class: 'muted', style: { textAlign: 'center', padding: '2rem' } }, 'Pick a template above…'));
      return;
    }
    let bodyText = currentTpl.body_text || '';
    const inputs = [...varsBody.querySelectorAll('input.var-input')];
    inputs.forEach((inp, idx) => {
      const placeholder = '{{' + (idx + 1) + '}}';
      const val = String(inp.value || '').trim() || placeholder;
      // Render @{merge} fields against the lead so the preview reflects what
      // the recipient will actually receive (e.g. @{name} → "Imran Khan")
      const merged = renderMergeClient(val, lead);
      bodyText = bodyText.split(placeholder).join(merged);
    });
    // Use existing template's full body — also render header/footer
    const components = currentTpl.components || [];
    const header = components.find(c => c.type === 'HEADER');
    const footer = components.find(c => c.type === 'FOOTER');
    const buttons = components.find(c => c.type === 'BUTTONS');
    previewBox.innerHTML = '';
    const card = h('div', { class: 'init-chat-card' });
    if (header && header.format === 'TEXT' && header.text) {
      card.appendChild(h('div', { class: 'tpl-header' }, header.text));
    }
    if (header && header.format === 'IMAGE') {
      card.appendChild(h('div', { class: 'tpl-header-img muted' }, '🖼 [Image header]'));
    }
    card.appendChild(h('div', { class: 'tpl-body' }, bodyText));
    if (footer && footer.text) {
      card.appendChild(h('div', { class: 'tpl-footer muted' }, footer.text));
    }
    if (buttons && Array.isArray(buttons.buttons)) {
      buttons.buttons.forEach(b => {
        card.appendChild(h('div', { class: 'tpl-btn' }, b.text || b.url || ''));
      });
    }
    previewBox.appendChild(card);
  }

  function setTemplate(combo) {
    const [name, lang] = String(combo || '').split('||');
    const t = approved.find(x => x.name === name && x.language === lang);
    currentTpl = t || null;
    varsBody.innerHTML = '';
    if (!t) {
      sendBtn.disabled = 'disabled';
      refreshPreview();
      return;
    }
    if (!t.body_params) {
      varsBody.appendChild(h('div', { class: 'muted', style: { padding: '.75rem' } },
        'Currently, the variable is not available for this template.'));
    } else {
      for (let i = 0; i < t.body_params; i++) {
        varsBody.appendChild(h('div', { style: { marginBottom: '.5rem' } },
          h('label', { class: 'muted', style: { fontSize: '.8rem' } }, 'Variable ' + (i + 1)),
          h('input', { class: 'var-input', placeholder: '@{name}, @{firstname}, @{phone}, …', oninput: refreshPreview })
        ));
      }
    }
    sendBtn.disabled = null;
    refreshPreview();
  }
  tplSel.addEventListener('change', () => setTemplate(tplSel.value));

  sendBtn.addEventListener('click', async () => {
    if (!currentTpl) return;
    const variables = [...varsBody.querySelectorAll('input.var-input')].map(i => i.value);
    sendBtn.disabled = 'disabled';
    sendBtn.textContent = 'Sending…';
    try {
      await api('api_wb_initiate_chat', {
        lead_id: lead?.id,
        phone,
        template_name: currentTpl.name,
        template_language: currentTpl.language,
        variables
      });
      toast('Sent — view delivery status in WhatsBot → Chat');
      m.remove();
    } catch (e) {
      toast(e.message, 'err');
      sendBtn.disabled = null;
      sendBtn.textContent = 'Send';
    }
  });
}

/** Replace @{merge_field} with values from the lead row — same syntax as
 *  the campaign worker server-side, just for the live preview here. */
function renderMergeClient(template, lead) {
  if (!template) return '';
  const ctx = lead || {};
  return String(template).replace(/@\{(\w+)\}/g, (_, key) => {
    const k = key.toLowerCase();
    if (k === 'firstname' || k === 'first_name') return String(ctx.name || '').split(' ')[0] || '';
    if (k === 'lastname' || k === 'last_name')   return String(ctx.name || '').split(' ').slice(1).join(' ') || '';
    if (k === 'name')   return String(ctx.name || '');
    if (k === 'phone')  return String(ctx.phone || '');
    if (k === 'email')  return String(ctx.email || '');
    if (k === 'source') return String(ctx.source || '');
    if (ctx[k] !== undefined) return String(ctx[k]);
    return '@{' + key + '}';
  });
}

function openCampaignModal(templates) {
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, '📣 Send new campaign'),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));
  const approved = (templates || []).filter(t => t.status === 'APPROVED');
  const statuses = CRM.cache.statuses || [];
  const sources = CRM.cache.sources || [];
  const users = CRM.cache.users || [];
  const tplOpts = approved.map(t => ({ value: t.name + '||' + t.language, label: t.name + ' (' + t.language + ')' }));
  const form = h('form', { class: 'form-grid' });
  form.appendChild(field('name', 'Campaign name *', '', { required: true }));
  form.appendChild(selectField('template_combo', 'Template *', '',
    [{ value: '', label: '— pick a template —' }, ...tplOpts]));
  // Filter pickers
  form.appendChild(selectField('status_id', 'Filter — status', '',
    [{ value: '', label: 'Any status' }, ...statuses.map(s => ({ value: s.id, label: s.name }))]));
  form.appendChild(selectField('source', 'Filter — source', '',
    [{ value: '', label: 'Any source' }, ...sources.map(s => ({ value: s.name, label: s.name }))]));
  form.appendChild(selectField('assigned_to', 'Filter — assignee', '',
    [{ value: '', label: 'Any' }, ...users.map(u => ({ value: u.id, label: u.name }))]));
  form.appendChild(field('tag', 'Filter — tag', ''));
  // Variables block
  const varsBox = h('div', { class: 'f-row full', id: 'cm-vars' });
  form.appendChild(varsBox);
  function renderVars(combo) {
    const [name, lang] = String(combo || '').split('||');
    const t = approved.find(x => x.name === name && x.language === lang);
    varsBox.innerHTML = '';
    if (!t) return;
    varsBox.appendChild(h('label', {}, 'Variables — use @{name}, @{firstname}, @{phone}, @{email}, @{source} for merge fields'));
    for (let i = 0; i < t.body_params; i++) {
      varsBox.appendChild(h('input', { name: 'cv_' + i, placeholder: 'Variable ' + (i + 1) }));
    }
  }
  form.querySelector('[name="template_combo"]')?.addEventListener('change', ev => renderVars(ev.target.value));
  // Schedule
  form.appendChild(field('scheduled_at', 'Scheduled send time (optional)', '', { type: 'datetime-local' }));
  form.appendChild(h('div', { class: 'f-row' },
    h('label', {}, 'Send now'),
    h('label', { class: 'qual-toggle' },
      h('input', { type: 'checkbox', name: 'send_now', checked: 'checked' }),
      ' Ignore schedule and send right away')
  ));
  body.appendChild(form);
  body.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: () => m.remove() }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      const combo = form.querySelector('[name="template_combo"]').value;
      const [name, lang] = combo.split('||');
      if (!name) { toast('Pick a template', 'err'); return; }
      const variables = [];
      [...form.querySelectorAll('input[name^="cv_"]')].forEach((i, idx) => variables.push({ name: 'V' + (idx + 1), value: i.value }));
      const filter = {
        status_id: form.status_id.value || undefined,
        source: form.source.value || undefined,
        assigned_to: form.assigned_to.value || undefined,
        tag: form.tag.value || undefined
      };
      try {
        const r = await api('api_wb_campaigns_create', {
          name: form.name.value,
          template_name: name, template_language: lang || 'en_US',
          variables, filter,
          scheduled_at: form.scheduled_at.value ? new Date(form.scheduled_at.value).toISOString() : null,
          send_now: form.send_now.checked ? 1 : 0
        });
        toast(`Campaign created — ${r.recipients} recipients`);
        m.remove();
        showWbTab('campaigns');
      } catch (e) { toast(e.message, 'err'); }
    } }, 'Create campaign')
  ));
  m.appendChild(body);
  document.body.appendChild(m);
}

// ---------- Chat ----------
//
// The Chat tab auto-polls so inbound messages from the WhatsApp webhook show
// up live, without the user reloading. Two independent loops:
//
//   - Thread list: every 8s. Cheap query (last 1000 messages aggregated).
//   - Active thread: every 4s while a thread is open. Re-renders the message
//     log only if the message count or the last status field changed, so an
//     in-progress textarea is never disturbed.
//
// Polling is parked on `window._wbChatTimers` so showWbTab() can clear them
// when the user navigates to a different WhatsBot subtab.
/**
 * Translate a Meta API error string into a short, user-friendly hint.
 * The full original error stays in the bubble's `title` (hover tooltip)
 * so admins can still copy the raw text for support.
 */
function waFriendlyError(err) {
  const e = String(err || '').toLowerCase();
  if (!e) return '⚠ Send failed — no reason returned. Try again.';
  if (e.includes('131047') || e.includes('re-engagement') || e.includes('24 hours') || e.includes('outside the allowed window')) {
    return '⚠ 24-hour window expired — the customer hasn\'t messaged in 24h. Send a Template message instead (Templates tab).';
  }
  if (e.includes('131026') || e.includes('not a whatsapp user') || e.includes('recipient cannot be sent')) {
    return '⚠ Number is not on WhatsApp.';
  }
  if (e.includes('131051') || e.includes('unsupported')) {
    return '⚠ Message type not supported by WhatsApp.';
  }
  if (e.includes('131052') || e.includes('media download')) {
    return '⚠ Media download error — check the file URL.';
  }
  if (e.includes('rate limit') || e.includes('throttle')) {
    return '⚠ Rate limit hit — try again in a minute.';
  }
  if (e.includes('access token') || e.includes('expired') || e.includes('oauth')) {
    return '⚠ WhatsApp access token expired. Settings → WhatsBot → Connect Account.';
  }
  // Fall back to the raw message but trimmed
  return '⚠ ' + String(err).slice(0, 200);
}

/**
 * Render the inline media preview (image / document / video / audio) that
 * sits at the top of a WhatsApp message bubble. Returns null for plain
 * text messages so the caller can skip the slot.
 */
function renderWaMessageMedia(msg) {
  const t = String(msg.message_type || '').toLowerCase();
  if (!t || t === 'text') return null;
  const url = msg.media_url || '';
  if (t === 'image') {
    if (!url) return h('div', { class: 'wb-msg-media muted' }, '🖼 [image]');
    return h('a', { href: url, target: '_blank', rel: 'noopener', class: 'wb-msg-image' },
      h('img', { src: url, alt: 'image', loading: 'lazy' })
    );
  }
  if (t === 'video') {
    if (!url) return h('div', { class: 'wb-msg-media muted' }, '🎬 [video]');
    return h('video', { class: 'wb-msg-video', controls: true, preload: 'none', src: url });
  }
  if (t === 'audio') {
    if (!url) return h('div', { class: 'wb-msg-media muted' }, '🎤 [audio]');
    return h('audio', { class: 'wb-msg-audio', controls: true, preload: 'none', src: url });
  }
  if (t === 'document') {
    return h('a', { href: url || '#', target: '_blank', rel: 'noopener', class: 'wb-msg-doc' },
      h('span', { class: 'wb-msg-doc-icon' }, '📄'),
      h('span', { class: 'wb-msg-doc-name' }, msg.body || 'Document')
    );
  }
  return h('div', { class: 'wb-msg-media muted' }, '[' + t + ']');
}

/**
 * Agent assignment picker for the chat header. Admins / managers / TLs
 * can pick any agent; reps get a "Claim chat" button that assigns the
 * chat to themselves. Fires api_wb_chat_assign and refreshes the list.
 */
function buildAgentPicker(phone, threadMeta) {
  const role = CRM.user.role;
  const isPriv = (role === 'admin' || role === 'manager' || role === 'team_leader');
  const wrap = h('div', { class: 'wb-agent-pick' });
  const labelText = threadMeta.assigned_name
    ? '👤 ' + threadMeta.assigned_name + (threadMeta.assignment_explicit ? '' : ' · auto')
    : '👤 Unassigned';
  const labelEl = h('span', { class: 'wb-agent-pick-label' }, labelText);
  wrap.appendChild(labelEl);

  if (!isPriv) {
    if (Number(threadMeta.assigned_to) !== Number(CRM.user.id)) {
      const claim = h('button', { class: 'btn xs primary', title: 'Claim this chat for me' }, 'Claim');
      claim.onclick = async () => {
        try {
          await api('api_wb_chat_assign', { phone, user_id: CRM.user.id });
          toast('✓ Chat assigned to you');
          if (window._wbChatTimers) window._wbChatTimers.threadList && window._wbChatTimers.threadList; // poll picks up
        } catch (e) { toast(e.message, 'err'); }
      };
      wrap.appendChild(claim);
    }
    return wrap;
  }

  // Privileged: dropdown of all users
  const sel = h('select', { class: 'wb-agent-pick-select' }, h('option', { value: '' }, '— Unassigned —'));
  // Lazily fetch users
  api('api_users_list').then(users => {
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: '' }, '— Unassigned —'));
    users.forEach(u => {
      const opt = h('option', { value: String(u.id) }, u.name);
      if (Number(u.id) === Number(threadMeta.assigned_to)) opt.selected = true;
      sel.appendChild(opt);
    });
  }).catch(() => {});
  sel.onchange = async () => {
    try {
      await api('api_wb_chat_assign', { phone, user_id: sel.value || null });
      toast('✓ Assignment updated');
      // Update the label inline without a full re-render
      const opt = sel.options[sel.selectedIndex];
      labelEl.textContent = '👤 ' + (opt && opt.value ? opt.text : 'Unassigned');
    } catch (e) { toast(e.message, 'err'); }
  };
  wrap.appendChild(sel);
  return wrap;
}

/**
 * Compose bar for a single chat thread — textarea + 📎 attach + send.
 * Calls onSent after every successful send so the parent can redraw.
 */
function buildWaCompose(phone, onSent) {
  const wrap = h('div', { class: 'wb-chat-compose' });
  let pending = null; // { id, wa_media_id, mime_type, filename, url }

  const previewSlot = h('div', { class: 'wb-compose-preview', hidden: 'hidden' });
  const input = h('textarea', { rows: 2, placeholder: 'Type a message — Enter to send, Shift+Enter for newline' });
  const fileInput = h('input', { type: 'file', style: { display: 'none' }, accept: 'image/*,application/pdf,video/mp4,video/3gp,audio/aac,audio/mp4,audio/mpeg,audio/amr,audio/ogg,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv' });

  const renderPreview = () => {
    previewSlot.innerHTML = '';
    if (!pending) { previewSlot.hidden = true; return; }
    previewSlot.hidden = false;
    const isImg = String(pending.mime_type || '').startsWith('image/');
    previewSlot.appendChild(isImg
      ? h('img', { src: pending.url, alt: pending.filename, class: 'wb-compose-thumb' })
      : h('span', { class: 'wb-compose-doc' }, '📄 ', pending.filename || 'Document')
    );
    previewSlot.appendChild(h('button', {
      class: 'btn xs ghost', title: 'Remove attachment',
      onclick: () => { pending = null; fileInput.value = ''; renderPreview(); }
    }, '✕'));
  };

  const send = async () => {
    const text = input.value.trim();
    if (!text && !pending) return;
    input.disabled = true;
    try {
      const payload = { phone, text };
      if (pending) {
        payload.media_id = pending.wa_media_id;
        payload.media_type = waMediaTypeFor(pending.mime_type);
        payload.media_url = pending.url; // for local rendering
        payload.filename = pending.filename || undefined;
      }
      await api('api_wb_chat_send', payload);
      input.value = '';
      pending = null; fileInput.value = ''; renderPreview();
      if (typeof onSent === 'function') onSent();
    } catch (e) { toast(e.message, 'err'); }
    finally { input.disabled = false; input.focus(); }
  };

  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) {
      toast('File too large — WhatsApp allows up to 16 MB images and 100 MB docs, but our upload limit is 25 MB', 'err');
      fileInput.value = '';
      return;
    }
    const fd = new FormData();
    fd.append('file', f);
    previewSlot.innerHTML = '';
    previewSlot.hidden = false;
    previewSlot.appendChild(h('span', { class: 'muted' }, 'Uploading ' + f.name + '…'));
    try {
      const r = await fetch('/api/wa/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + (CRM.token || '') },
        body: fd
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('upload failed (' + r.status + ')'));
      pending = j;
      renderPreview();
      input.focus();
    } catch (e) {
      pending = null; fileInput.value = '';
      previewSlot.hidden = true;
      toast(e.message || 'Upload failed', 'err');
    }
  });

  const attachBtn = h('button', { class: 'btn ghost wb-attach-btn', title: 'Attach a photo or document', onclick: () => fileInput.click() }, '📎');
  const tplBtn    = h('button', { class: 'btn ghost wb-tpl-btn',
    title: 'Send a pre-approved template — works even when the customer hasn\'t messaged in 24h',
    onclick: () => openWaTemplatePicker(phone, () => { if (typeof onSent === 'function') onSent(); })
  }, '📋');
  const sendBtn   = h('button', { class: 'btn primary wb-send-btn', title: 'Send', onclick: send }, 'Send');

  wrap.appendChild(previewSlot);
  wrap.appendChild(h('div', { class: 'wb-compose-row' }, attachBtn, tplBtn, input, sendBtn, fileInput));
  return wrap;
}

/**
 * Modal that lists approved WhatsApp templates and lets the rep send one
 * to a contact. Used as a fallback when free-form text is blocked by the
 * 24-hour window or any other Meta error.
 */
async function openWaTemplatePicker(phone, onSent) {
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const card = h('div', { class: 'modal', style: { maxWidth: '560px' } },
    h('div', { class: 'modal-head' },
      h('h3', {}, '📋 Send a template to ', phone),
      h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
    )
  );
  const body = h('div', { class: 'modal-body' });
  body.appendChild(h('p', { class: 'muted' }, 'Pre-approved templates can be sent any time — even outside the 24-hour reply window.'));
  const listEl = h('div', { class: 'wb-tpl-list' });
  body.appendChild(listEl);
  card.appendChild(body);
  m.appendChild(card);
  document.body.appendChild(m);

  let tpls = [];
  try { tpls = await api('api_wb_templates_list'); }
  catch (e) {
    listEl.appendChild(h('div', { class: 'error-box' }, e.message));
    return;
  }
  const approved = (tpls || []).filter(t => String(t.status || '').toUpperCase() === 'APPROVED');
  if (!approved.length) {
    listEl.appendChild(h('p', { class: 'muted' },
      'No approved templates yet. Go to ', h('b', {}, 'WhatsBot → Templates'), ' to sync from Meta or create one.'));
    return;
  }
  approved.forEach(t => {
    const row = h('div', { class: 'wb-tpl-row' },
      h('div', {},
        h('b', {}, t.name),
        h('span', { class: 'muted' }, ' · ' + (t.language || 'en') + ' · ' + (t.category || ''))
      ),
      h('button', { class: 'btn sm primary' }, 'Send')
    );
    row.querySelector('button').onclick = async () => {
      try {
        await api('api_wb_initiate_chat', {
          phone, template_name: t.name, template_language: t.language || 'en_US', variables: []
        });
        toast('✓ Template sent');
        m.remove();
        if (typeof onSent === 'function') onSent();
      } catch (e) { toast(e.message, 'err'); }
    };
    listEl.appendChild(row);
  });
}

/**
 * Pick the correct WhatsApp `type` value for a given MIME. WhatsApp accepts
 * image / video / audio / document — anything we don't recognise falls
 * back to `document`.
 */
function waMediaTypeFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

async function wbChat() {
  // Kill any previous timers if wbChat is mounted twice (e.g. tab reopened).
  if (window._wbChatTimers) {
    clearInterval(window._wbChatTimers.threadList);
    clearInterval(window._wbChatTimers.activeThread);
  }
  window._wbChatTimers = { threadList: null, activeThread: null };

  const wrap = h('div', { class: 'wb-chat' });
  const left = h('div', { class: 'wb-chat-list' });
  const right = h('div', { class: 'wb-chat-thread' },
    h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, '← Pick a contact'));
  wrap.appendChild(left);
  wrap.appendChild(right);

  // Track which thread is currently open + a fingerprint of its last render
  // so polling can decide whether to redraw.
  let openPhone = null;
  let openFingerprint = '';
  let lastThreadsFingerprint = '';

  function _threadFingerprint(threads) {
    return threads.map(t => `${t.phone}|${t.last_at}|${t.unread}|${t.assigned_to || 0}|${agentFilterId || ''}`).join(';');
  }
  // Admin / manager filter — when non-null, threads are limited to chats
  // assigned to that user. Persisted on `wbChat`'s closure so the filter
  // survives auto-polling redraws.
  let agentFilterId = '';
  let chatUsers = [];     // populated once per render
  function _msgFingerprint(msgs) {
    return msgs.map(m => `${m.id}|${m.status || ''}|${m.read_at || ''}|${m.delivered_at || ''}`).join(';');
  }

  async function renderThreadList() {
    let threads;
    try { threads = await api('api_wb_chat_threads'); }
    catch (_) { threads = []; }

    // Apply admin / manager agent filter if set
    const filtered = agentFilterId
      ? threads.filter(t => Number(t.assigned_to) === Number(agentFilterId))
      : threads;

    const fp = _threadFingerprint(filtered);
    if (fp === lastThreadsFingerprint) return; // No change — preserve scroll
    lastThreadsFingerprint = fp;

    // Lazily fetch the user roster the FIRST time the list renders so we
    // can populate the agent-filter dropdown + assignment picker.
    if (!chatUsers.length && (CRM.user.role === 'admin' || CRM.user.role === 'manager' || CRM.user.role === 'team_leader')) {
      try { chatUsers = await api('api_users_list'); } catch (_) { chatUsers = []; }
    }

    left.innerHTML = '';
    left.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '.5rem' } },
      h('h4', { style: { margin: 0 } }, '💭 Chats (' + filtered.length + ')'),
      h('button', { class: 'btn sm ghost', title: 'Refresh now', onclick: () => { lastThreadsFingerprint = ''; renderThreadList(); if (openPhone) renderActiveThread(true); } }, '↻')
    ));

    // Agent filter — admins/managers/TLs only
    const canFilter = (CRM.user.role === 'admin' || CRM.user.role === 'manager' || CRM.user.role === 'team_leader');
    if (canFilter && chatUsers.length) {
      const sel = h('select', { class: 'wb-agent-filter', style: { width: '100%', marginBottom: '.5rem' } },
        h('option', { value: '' }, 'All agents'),
        ...chatUsers.map(u => h('option', { value: String(u.id), selected: String(u.id) === String(agentFilterId) ? 'selected' : null }, u.name))
      );
      sel.onchange = () => {
        agentFilterId = sel.value;
        lastThreadsFingerprint = '';
        renderThreadList();
      };
      left.appendChild(sel);
    }

    if (!filtered.length) {
      left.appendChild(h('p', { class: 'muted' },
        agentFilterId ? 'No chats assigned to this agent.' : 'No conversations yet. Inbound WhatsApp messages will appear here automatically.'));
      return;
    }
    filtered.forEach(t => {
      const ownerLabel = t.assigned_name
        ? h('span', { class: 'wb-row-agent' + (t.assignment_explicit ? ' explicit' : '') },
            '👤 ' + t.assigned_name + (t.assignment_explicit ? '' : ' · auto')
          )
        : h('span', { class: 'wb-row-agent unassigned' }, '👤 Unassigned');
      const row = h('div', { class: 'wb-chat-row' + (t.phone === openPhone ? ' active' : ''), onclick: () => openThread(t.phone) },
        h('div', {}, h('b', {}, t.lead_name || t.phone), t.unread ? h('span', { class: 'wb-unread' }, t.unread) : null),
        h('div', { class: 'muted', style: { fontSize: '.78rem' } }, t.phone),
        ownerLabel,
        h('div', { class: 'muted', style: { fontSize: '.78rem', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.last_message_type === 'text' ? t.last_message : ('[' + t.last_message_type + ']')),
        h('div', { class: 'muted', style: { fontSize: '.7rem' } }, fmtDate(t.last_at, 'relative'))
      );
      left.appendChild(row);
    });
  }

  /**
   * Render the message log for the currently open thread.
   *
   * `force` re-renders even if the fingerprint is unchanged — used when the
   * user clicks ↻ Refresh manually.
   *
   * Re-renders ONLY the message log container, never the textarea, so the
   * user's in-progress draft is preserved.
   */
  async function renderActiveThread(force) {
    if (!openPhone) return;
    let msgs;
    try { msgs = await api('api_wb_chat_messages', openPhone); }
    catch (_) { msgs = []; }
    const fp = _msgFingerprint(msgs);
    if (!force && fp === openFingerprint) return;
    openFingerprint = fp;

    const log = right.querySelector('.wb-chat-log');
    if (!log) return; // The thread pane was torn down — bail.
    const wasNearBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 80;
    log.innerHTML = '';
    msgs.forEach(msg => {
      const isFailed = msg.status === 'failed' || !!msg.error_text;
      const tickClass = msg.read_at ? 'read' : msg.delivered_at ? 'delivered' : 'sent';
      const tickGlyph = isFailed ? '⚠'
                      : msg.read_at ? '✓✓'
                      : msg.delivered_at ? '✓✓'
                      : '✓';
      // For media messages, show an inline preview / download chip on top
      // of the caption (msg.body holds the caption when it's a media msg).
      const mediaNode = renderWaMessageMedia(msg);
      log.appendChild(h('div', { class: 'wb-msg ' + (msg.direction === 'in' ? 'in' : 'out') + (isFailed ? ' failed' : '') },
        mediaNode,
        h('div', { class: 'wb-msg-body' }, msg.body || (mediaNode ? '' : '[' + (msg.message_type || '') + ']')),
        isFailed
          ? h('div', { class: 'wb-msg-error', title: msg.error_text || 'Send failed' },
              waFriendlyError(msg.error_text))
          : null,
        h('div', { class: 'wb-msg-meta muted' },
          fmtDate(msg.created_at, 'relative'),
          msg.direction === 'out'
            ? h('span', { class: 'wb-tick ' + (isFailed ? 'failed' : tickClass), title: isFailed ? (msg.error_text || 'failed') : tickClass }, ' · ' + tickGlyph)
            : null
        )
      ));
    });
    // Auto-scroll to bottom IF the user was already at/near the bottom.
    // If they had scrolled up to read history, leave them there.
    if (wasNearBottom) setTimeout(() => { log.scrollTop = log.scrollHeight; }, 50);
  }

  function backToList() {
    openPhone = null;
    openFingerprint = '';
    wrap.classList.remove('thread-open');
    [...left.querySelectorAll('.wb-chat-row')].forEach(r => r.classList.remove('active'));
    right.innerHTML = h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, '← Pick a contact').outerHTML;
  }

  async function openThread(phone) {
    openPhone = phone;
    openFingerprint = ''; // Force a render
    wrap.classList.add('thread-open');  // mobile: hide list, show thread
    // Mark thread row active
    [...left.querySelectorAll('.wb-chat-row')].forEach(r => r.classList.remove('active'));

    right.innerHTML = '';
    // Look up the thread row we have for this phone so we know who it's
    // currently assigned to. (Comes from the threads list we just fetched.)
    const threadMeta = (await api('api_wb_chat_threads').catch(() => [])).find(t => t.phone === phone) || {};
    const head = h('div', { class: 'wb-chat-head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.5rem', flexWrap: 'wrap' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem' } },
        h('button', { class: 'wb-chat-back', title: 'Back to list', onclick: backToList }, '← Back'),
        h('b', {}, threadMeta.lead_name || phone),
        threadMeta.lead_name ? h('span', { class: 'muted', style: { fontSize: '.78rem' } }, phone) : null
      ),
      buildAgentPicker(phone, threadMeta),
      h('button', { class: 'btn sm ghost', title: 'Refresh this thread', onclick: () => renderActiveThread(true) }, '↻')
    );
    right.appendChild(head);
    const log = h('div', { class: 'wb-chat-log' });
    log.innerHTML = '<div class="loading">Loading…</div>';
    right.appendChild(log);

    right.appendChild(buildWaCompose(phone, () => {
      // After a successful send: redraw thread + bump the list
      renderActiveThread(true);
      lastThreadsFingerprint = '';
      renderThreadList();
    }));

    await renderActiveThread(true);
    // Refresh the list too — opening a thread marks inbound as read on the
    // server, so unread badges should clear in the left pane.
    lastThreadsFingerprint = '';
    await renderThreadList();
  }

  // Initial render + auto-poll
  await renderThreadList();
  window._wbChatTimers.threadList = setInterval(() => {
    // Pause polling when the tab is hidden — saves battery on mobile and
    // avoids piling up requests if the user steps away for an hour.
    if (document.visibilityState === 'hidden') return;
    renderThreadList().catch(() => {});
  }, 8000);
  window._wbChatTimers.activeThread = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (openPhone) renderActiveThread(false).catch(() => {});
  }, 4000);

  return wrap;
}

// ---------- Auto-assign rules ----------
/**
 * Settings panel: how new inbound chats get routed to agents.
 *   - lead_owner   — give it to whoever owns the linked lead (default)
 *   - round_robin  — cycle through a pool of agents
 *   - least_busy   — give it to the agent with the fewest active chats
 *   - manual       — admin assigns by hand from the chat header dropdown
 */
async function wbAssignSettings() {
  const wrap = h('div', { class: 'card', style: { maxWidth: '720px' } });
  wrap.appendChild(h('h3', { style: { marginTop: 0 } }, '👥 Auto-assign rules'));
  wrap.appendChild(h('p', { class: 'muted' },
    'Decide how brand-new inbound WhatsApp chats are routed to agents. ',
    'These rules only apply when a chat doesn\'t already have an agent — once a chat is assigned (manually or by a rule) the assignment sticks until someone changes it.'
  ));

  let s;
  try { s = await api('api_wb_assign_settings_get'); }
  catch (e) {
    wrap.appendChild(h('div', { class: 'error-box' }, e.message));
    return wrap;
  }

  // Direct refs — `$()` would return null because wrap isn't in the DOM yet.
  const modeSel = h('select', {},
    h('option', { value: 'lead_owner', selected: s.mode === 'lead_owner' ? 'selected' : null },
      'Lead owner (default) — assign to whoever owns the linked lead'),
    h('option', { value: 'round_robin', selected: s.mode === 'round_robin' ? 'selected' : null },
      'Round-robin — cycle through the agent pool'),
    h('option', { value: 'least_busy', selected: s.mode === 'least_busy' ? 'selected' : null },
      'Least-busy — give it to the agent with fewest active chats'),
    h('option', { value: 'manual', selected: s.mode === 'manual' ? 'selected' : null },
      'Manual — admin assigns from the chat header')
  );
  wrap.appendChild(h('div', { class: 'form-row' }, h('label', {}, 'Mode'), modeSel));

  // Pool multi-select (only relevant for round_robin / least_busy)
  const poolList = h('div', { class: 'aa-pool-list' });
  const poolWrap = h('div', { class: 'form-row' },
    h('label', {},
      'Agent pool ',
      h('span', { class: 'muted' }, '(round-robin / least-busy only)')
    ),
    poolList
  );
  wrap.appendChild(poolWrap);

  s.users.forEach(u => {
    const checked = s.pool.includes(Number(u.id)) ? 'checked' : null;
    poolList.appendChild(h('label', { class: 'aa-pool-item' },
      h('input', { type: 'checkbox', class: 'aa-pool-cb', value: String(u.id), checked }),
      h('span', {}, u.name + ' '),
      h('span', { class: 'muted' }, u.role)
    ));
  });

  // Show / hide pool depending on mode
  const updatePoolVisibility = () => {
    const isPoolMode = (modeSel.value === 'round_robin' || modeSel.value === 'least_busy');
    poolWrap.style.opacity = isPoolMode ? '1' : '0.45';
    poolWrap.style.pointerEvents = isPoolMode ? 'auto' : 'none';
  };
  modeSel.onchange = updatePoolVisibility;
  updatePoolVisibility();

  // Save button
  const saveBtn = h('button', { class: 'btn primary' }, '💾 Save rules');
  saveBtn.onclick = async () => {
    const mode = modeSel.value;
    const pool = [...poolList.querySelectorAll('.aa-pool-cb:checked')].map(cb => Number(cb.value));
    if ((mode === 'round_robin' || mode === 'least_busy') && !pool.length) {
      toast('Pick at least one agent for the pool', 'err');
      return;
    }
    saveBtn.disabled = true;
    try {
      await api('api_wb_assign_settings_save', { mode, pool });
      toast('✓ Auto-assign rules saved');
    } catch (e) { toast(e.message, 'err'); }
    finally { saveBtn.disabled = false; }
  };
  wrap.appendChild(h('div', { style: { marginTop: '1rem' } }, saveBtn));

  // Help text
  wrap.appendChild(h('details', { style: { marginTop: '1.25rem' } },
    h('summary', { class: 'muted' }, 'How does this work?'),
    h('ul', { style: { paddingLeft: '1.2rem', lineHeight: '1.6' } },
      h('li', {}, h('b', {}, 'Lead owner'), ' — when a new WhatsApp message arrives, the chat goes to whoever owns the lead with that phone number. If the lead has no owner, the chat stays unassigned (admin only).'),
      h('li', {}, h('b', {}, 'Round-robin'), ' — chats are distributed evenly across the agent pool. The system remembers who got the last one and gives the next chat to the next agent in line.'),
      h('li', {}, h('b', {}, 'Least-busy'), ' — counts how many chats each agent currently owns and gives the new chat to whoever has the fewest. Good for keeping load balanced when reps work different volumes.'),
      h('li', {}, h('b', {}, 'Manual'), ' — chats stay unassigned until an admin/manager picks an agent from the chat header dropdown.'),
      h('li', {}, 'Already-assigned chats are never re-assigned by these rules. Use the per-chat agent picker to move them.')
    )
  ));

  return wrap;
}

// ---------- Activity Log ----------
async function wbActivity() {
  const wrap = h('div', {});

  // Toolbar with category filter + search + auto-refresh + clear
  const catSel = h('select', { id: 'wb-act-cat' },
    h('option', { value: '' }, 'All categories'),
    h('option', { value: 'chat' }, '💬 Chat (outbound)'),
    h('option', { value: 'campaign' }, '📣 Campaigns'),
    h('option', { value: 'message_bot' }, '🤖 Message bots'),
    h('option', { value: 'template_bot' }, '🤖 Template bots'),
    h('option', { value: 'template_sync' }, '📋 Template sync'),
    h('option', { value: 'webhook_in' }, '📥 Webhook (raw)'),
    h('option', { value: 'webhook_status' }, '✅ Status updates'),
    h('option', { value: 'webhook_message' }, '📩 Inbound messages')
  );
  const searchInp = h('input', { id: 'wb-act-q', placeholder: 'Search name / template…', style: { flex: 1 } });
  const tbody = h('tbody', {});
  const reload = async () => {
    const data = await api('api_wb_activity_list', { category: catSel.value || undefined, q: searchInp.value || undefined }).catch(() => []);
    tbody.innerHTML = '';
    if (!data.length) {
      tbody.appendChild(h('tr', {}, h('td', { colspan: 8, class: 'muted', style: { textAlign: 'center', padding: '1.5rem' } }, 'No activity matching this filter.')));
      return;
    }
    data.forEach(r => {
      const codeColor = r.response_code === 200 ? '#10b981' : (r.response_code ? '#ef4444' : '#94a3b8');
      const catColor = {
        chat: '#3b82f6', campaign: '#8b5cf6',
        message_bot: '#06b6d4', template_bot: '#06b6d4',
        template_sync: '#64748b',
        webhook_in: '#fbbf24', webhook_status: '#10b981', webhook_message: '#14b8a6'
      }[r.category] || '#64748b';
      tbody.appendChild(h('tr', {},
        h('td', {}, r.id),
        h('td', {}, h('span', { class: 'tag', style: { background: catColor, color: '#fff', fontSize: '.7rem' } }, r.category)),
        h('td', {}, r.name || '—'),
        h('td', {}, r.template_name ? h('code', {}, r.template_name) : '—'),
        h('td', {}, h('span', { class: 'tag', style: { background: codeColor, color: '#fff' } }, r.response_code || '—')),
        h('td', { class: 'muted' }, r.type || '—'),
        h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } }, fmtDate(r.recorded_on, 'relative')),
        h('td', {}, h('button', { class: 'btn sm', onclick: () => openWbActivityDetailModal(r.id) }, '🔍 View'))
      ));
    });
  };
  catSel.onchange = reload;
  let _searchTimer = null;
  searchInp.oninput = () => { clearTimeout(_searchTimer); _searchTimer = setTimeout(reload, 300); };

  wrap.appendChild(h('div', { class: 'toolbar' },
    h('h3', { style: { margin: 0 } }, '📑 Activity log'),
    catSel,
    searchInp,
    h('button', { class: 'btn', onclick: reload, title: 'Refresh' }, '🔄'),
    // Download raw webhook events as plain text (for offline analysis /
    // sharing). Uses api_wb_webhook_logs_text which dumps all webhook_in /
    // webhook_status / webhook_message entries with full JSON.
    h('button', { class: 'btn', title: 'Download raw webhook log as wa_webhook_logs.txt', onclick: async () => {
      try {
        toast('Building log…');
        const txt = await api('api_wb_webhook_logs_text');
        const blob = new Blob([txt], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'wa_webhook_logs_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt';
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
        toast('Downloaded');
      } catch (e) { toast(e.message, 'err'); }
    } }, '⬇️ Download .txt'),
    h('button', { class: 'btn ghost danger', onclick: async () => {
      if (!await confirmDialog('Clear all activity log entries?')) return;
      await api('api_wb_activity_clear'); toast('Cleared'); showWbTab('activity');
    } }, '🗑️ Clear log')
  ));

  wrap.appendChild(h('p', { class: 'muted', style: { fontSize: '.85rem' } },
    'Every send to Meta and every webhook from Meta is logged here. ',
    'Click 🔍 View on any row to see the full request/response JSON. ',
    'Webhook URL: ', h('code', {}, location.origin + '/hook/whatsapp_webhook')
  ));

  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, '#'), h('th', {}, 'Category'), h('th', {}, 'Name'),
      h('th', {}, 'Template'), h('th', {}, 'Code'), h('th', {}, 'Type'),
      h('th', {}, 'Recorded on'), h('th', {}, '')
    )),
    tbody
  )));
  await reload();
  return wrap;
}

/**
 * Detail modal — shows the full request and response JSON for a single
 * activity log row. Two-column layout (request / response) with clean
 * pretty-printing so the user can read what we sent to Meta and what
 * Meta sent back.
 */
async function openWbActivityDetailModal(id) {
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, '📑 Activity #' + id),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));
  const content = h('div', {}, h('div', { class: 'muted' }, 'Loading…'));
  body.appendChild(content);
  m.appendChild(body);
  document.body.appendChild(m);

  try {
    const r = await api('api_wb_activity_get', id);
    content.innerHTML = '';
    // Header row
    content.appendChild(h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '.5rem', marginBottom: '1rem' } },
      h('span', { class: 'tag', style: { background: '#3b82f6', color: '#fff' } }, r.category || ''),
      r.name ? h('span', { class: 'tag', style: { background: '#64748b', color: '#fff' } }, r.name) : null,
      r.template_name ? h('span', { class: 'tag', style: { background: '#10b981', color: '#fff' } }, r.template_name) : null,
      r.response_code ? h('span', { class: 'tag', style: { background: r.response_code === 200 ? '#10b981' : '#ef4444', color: '#fff' } }, 'HTTP ' + r.response_code) : null,
      h('span', { class: 'muted' }, fmtDate(r.recorded_on))
    ));
    // Two-column request/response viewer
    const grid = h('div', { class: 'wb-act-grid' });
    grid.appendChild(h('div', { class: 'card' },
      h('h4', { style: { marginTop: 0 } }, '📤 Request (we sent)'),
      h('pre', { class: 'wb-json' }, JSON.stringify(r.request || {}, null, 2))
    ));
    grid.appendChild(h('div', { class: 'card' },
      h('h4', { style: { marginTop: 0 } }, '📥 Response (Meta returned)'),
      h('pre', { class: 'wb-json' }, JSON.stringify(r.response || {}, null, 2))
    ));
    content.appendChild(grid);
    // Copy buttons
    content.appendChild(h('div', { style: { marginTop: '1rem' } },
      h('button', { class: 'btn sm', onclick: () => { navigator.clipboard.writeText(JSON.stringify(r, null, 2)); toast('Copied full JSON'); } }, '📋 Copy full JSON')
    ));
  } catch (e) {
    content.innerHTML = '';
    content.appendChild(h('div', { class: 'error-box' }, 'Could not load: ' + e.message));
  }
}

/**
 * TAT report view. Shows three sections:
 *   - Top KPI cards   (open violations, total leads, avg first-action min)
 *   - Per-user table  (avg time-to-1st-action, avg time-to-2nd-action)
 *   - Per-stage table (avg minutes leads spend in each stage)
 *   - Active violation list (escalation level, age, assignee)
 * Filters by date range + user.
 */
/* ===========================================================
 * Monthly Target dashboard — every metric requested by product:
 *   - Revenue Achieved        - Required Daily Target (Auto)
 *   - Target Remaining         - Conversion Rate
 *   - Days Left                - Forecasted Revenue
 *   - Achievement %            - Funnel Conversion
 *   - Weekly Trend             - Lead vs Sale Conversion Rate
 *   - Revenue Left (= Target Remaining alias)
 * Admins/managers can set targets per rep + org-wide.
 * Reps see their own scope by default.
 * =========================================================== */

function _tInr(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return '—';
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2) + ' Cr';
  if (n >= 100000)   return '₹' + (n / 100000).toFixed(2) + ' L';
  if (n >= 1000)     return '₹' + (n / 1000).toFixed(1) + 'k';
  return '₹' + n.toFixed(0);
}
function _tPct(v) { return v == null ? '—' : (Math.round(v * 10) / 10) + '%'; }

/* ---------------- Inventory ---------------- */
VIEWS.inventory = async (view) => {
  const isAdminMgr = ['admin', 'manager'].includes(CRM.user.role);
  view.innerHTML = '';
  let q = '';
  let statusFilter = 'available';
  let typeFilter = '';

  const head = h('div', { class: 'card', style: { padding: '1rem', display: 'flex', flexWrap: 'wrap', gap: '.75rem', alignItems: 'center', marginBottom: '1rem' } });
  head.appendChild(h('h3', { style: { margin: 0, flex: 1 } }, '📦 Inventory'));
  const searchInput = h('input', { type: 'search', placeholder: '🔍 Name, location, description…', style: { minWidth: '220px' } });
  const statusSel = h('select', {},
    h('option', { value: '' }, 'All statuses'),
    h('option', { value: 'available', selected: 'selected' }, 'Available'),
    h('option', { value: 'blocked' }, 'Blocked'),
    h('option', { value: 'sold' }, 'Sold'),
    h('option', { value: 'inactive' }, 'Inactive')
  );
  const typeInput = h('input', { type: 'text', placeholder: 'Type filter (e.g. Flat, Plot)', style: { minWidth: '160px' } });
  head.appendChild(searchInput);
  head.appendChild(statusSel);
  head.appendChild(typeInput);
  if (isAdminMgr) {
    head.appendChild(h('button', { class: 'btn primary', onclick: () => openInventoryEditModal(null, refresh) }, '+ Add item'));
  }
  view.appendChild(head);

  const listEl = h('div', { id: 'inventory-list' });
  view.appendChild(listEl);

  let _t;
  const debounced = () => { clearTimeout(_t); _t = setTimeout(refresh, 250); };
  searchInput.oninput = () => { q = searchInput.value || ''; debounced(); };
  statusSel.onchange = () => { statusFilter = statusSel.value; refresh(); };
  typeInput.oninput  = () => { typeFilter = typeInput.value || ''; debounced(); };

  async function refresh() {
    listEl.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const filters = { q };
      if (statusFilter) filters.status = statusFilter;
      if (typeFilter)   filters.item_type = typeFilter;
      const rows = await api('api_inventory_list', filters);
      listEl.innerHTML = '';
      if (!rows.length) {
        listEl.appendChild(h('p', { class: 'muted' }, 'No matching inventory.'));
        return;
      }
      const grid = h('div', { class: 'cards', style: { gap: '.75rem' } });
      rows.forEach(r => grid.appendChild(inventoryCard(r, refresh, isAdminMgr)));
      listEl.appendChild(grid);
    } catch (e) {
      listEl.innerHTML = '';
      listEl.appendChild(h('div', { class: 'error-box' }, e.message));
    }
  }
  await refresh();
};

function inventoryCard(r, refresh, isAdminMgr) {
  const statusColors = { available: '#10b981', blocked: '#f59e0b', sold: '#6b7280', inactive: '#9ca3af' };
  const card = h('div', { class: 'card', style: { padding: '1rem', display: 'flex', flexDirection: 'column', gap: '.5rem', minWidth: '260px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', justifyContent: 'space-between' } },
      h('h4', { style: { margin: 0 } }, r.name),
      h('span', {
        style: { background: statusColors[r.status] || '#6b7280', color: '#fff', padding: '.15rem .55rem', borderRadius: '999px', fontSize: '.72rem', fontWeight: 600 }
      }, String(r.status).toUpperCase())
    ),
    r.item_type ? h('div', { class: 'muted', style: { fontSize: '.85rem' } }, '📁 ' + r.item_type) : null,
    h('div', { style: { fontSize: '1.1rem', fontWeight: 600 } }, '₹ ' + Number(r.price).toLocaleString('en-IN')),
    r.location ? h('div', { class: 'muted', style: { fontSize: '.85rem' } }, '📍 ' + r.location) : null,
    r.description ? h('div', { class: 'muted', style: { fontSize: '.8rem' } },
      String(r.description).slice(0, 140) + (String(r.description).length > 140 ? '…' : '')
    ) : null,
    isAdminMgr ? h('div', { class: 'actions', style: { marginTop: '.25rem' } },
      h('button', { class: 'btn sm', onclick: () => openInventoryEditModal(r, refresh) }, '✎ Edit'),
      h('button', { class: 'btn sm danger', onclick: async () => {
        if (!await confirmDialog('Mark "' + r.name + '" inactive? It stops appearing in match suggestions.')) return;
        try { await api('api_inventory_delete', r.id); toast('Marked inactive'); refresh(); }
        catch (e) { toast(e.message, 'err'); }
      } }, '🗑')
    ) : null
  );
  return card;
}

function openInventoryEditModal(r, onSaved) {
  r = r || {};
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } });
  const f = (name, label, val, opts) => {
    opts = opts || {};
    return h('div', { class: 'f-row' + (opts.full ? ' full' : '') },
      h('label', {}, label),
      h('input', Object.assign({ name, value: val == null ? '' : val }, opts.attrs || { type: opts.type || 'text' }))
    );
  };
  modal.appendChild(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' },
      h('h3', {}, r.id ? 'Edit inventory item' : '+ New inventory item'),
      h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
    ),
    h('form', { id: 'inv-form', class: 'form-grid' },
      f('name', 'Name *', r.name, { attrs: { type: 'text', required: 'required' } }),
      f('item_type', 'Type (Flat / Plot / Plan / Product)', r.item_type),
      f('price', 'Price (₹)', r.price, { attrs: { type: 'number', min: 0, step: 1 } }),
      h('div', { class: 'f-row' },
        h('label', {}, 'Status'),
        h('select', { name: 'status' },
          ...['available', 'blocked', 'sold', 'inactive'].map(s =>
            h('option', { value: s, selected: (r.status || 'available') === s ? 'selected' : null }, s)
          )
        )
      ),
      f('location', 'Location / Address', r.location, { full: true }),
      h('div', { class: 'f-row full' },
        h('label', {}, 'Description'),
        h('textarea', { name: 'description', rows: 3 }, r.description || '')
      )
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const form = $('#inv-form');
        const fd = new FormData(form);
        const payload = {
          id: r.id,
          name:        fd.get('name'),
          item_type:   fd.get('item_type'),
          price:       Number(fd.get('price')) || 0,
          status:      fd.get('status') || 'available',
          location:    fd.get('location'),
          description: fd.get('description')
        };
        if (!payload.name) return toast('Name is required', 'err');
        try { await api('api_inventory_save', payload); toast('Saved'); modal.remove(); onSaved && onSaved(); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Save')
    )
  ));
  document.body.appendChild(modal);
}

/* ---------------- Projects (post-sale stage board) ---------------- */
VIEWS.projects = async (view) => {
  view.innerHTML = '';
  view.appendChild(h('div', { class: 'card', style: { padding: '1rem', display: 'flex', alignItems: 'center', gap: '.75rem', flexWrap: 'wrap', marginBottom: '1rem' } },
    h('h3', { style: { margin: 0, flex: 1 } }, '🚚 Projects in delivery'),
    h('span', { class: 'muted', style: { fontSize: '.85rem' } },
      'Every lead that has entered the post-sale stage tracker, grouped by stage. Stalled cards are flagged.'),
    ['admin'].includes(CRM.user.role)
      ? h('a', { class: 'btn', href: '#/admin', onclick: () => setTimeout(() => showAdminTab('projstages'), 100) }, '⚙ Edit stages')
      : null
  ));

  const listEl = h('div', { id: 'proj-board' }, h('div', { class: 'loading' }, 'Loading…'));
  view.appendChild(listEl);

  let board;
  try { board = await api('api_projectStages_board'); }
  catch (e) {
    listEl.innerHTML = '';
    listEl.appendChild(h('div', { class: 'error-box' }, e.message));
    return;
  }

  if (!board.stages.length) {
    listEl.innerHTML = '';
    listEl.appendChild(h('p', { class: 'muted' },
      'No stages defined yet. Admin: head to Settings → 🚚 Project stages to create your delivery workflow.'));
    return;
  }

  const totalLeads = board.board.reduce((n, col) => n + col.leads.length, 0);
  if (!totalLeads) {
    listEl.innerHTML = '';
    listEl.appendChild(h('p', { class: 'muted' },
      'No leads are in delivery yet. Open a won/closed lead → "🚚 Post-sale delivery" → Start delivery tracker.'));
    return;
  }

  const wrap = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '.75rem' } });
  board.board.forEach(col => {
    const stalledCount = col.leads.filter(l => l.stalled).length;
    const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: '.4rem', padding: '.5rem .75rem', background: '#f3f4f6', borderRadius: '6px 6px 0 0', borderBottom: '2px solid #3b82f6' } },
      h('span', { style: { fontWeight: 600, flex: 1 } }, col.stage.name),
      h('span', { class: 'tag', style: { background: '#dbeafe', color: '#1e40af' } }, col.leads.length),
      stalledCount ? h('span', { class: 'tag', style: { background: '#fef2f2', color: '#991b1b' }, title: stalledCount + ' lead(s) stuck longer than expected' }, '⚠ ' + stalledCount) : null
    );
    const colWrap = h('div', { class: 'card', style: { padding: 0, display: 'flex', flexDirection: 'column', gap: 0 } });
    colWrap.appendChild(head);
    if (col.leads.length === 0) {
      colWrap.appendChild(h('p', { class: 'muted', style: { padding: '.75rem', margin: 0, fontSize: '.85rem' } }, 'No leads here.'));
    }
    col.leads.forEach(l => {
      colWrap.appendChild(h('div', {
        class: 'card', style: { margin: '.4rem .5rem', padding: '.6rem .75rem', cursor: 'pointer', borderLeft: l.stalled ? '3px solid #ef4444' : '3px solid #e5e7eb' },
        onclick: () => openLeadModal(l.id)
      },
        h('div', { style: { fontWeight: 600 } }, l.name),
        l.value ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, '₹ ' + Number(l.value).toLocaleString('en-IN')) : null,
        l.assigned_name ? h('div', { class: 'muted', style: { fontSize: '.78rem' } }, '👤 ' + l.assigned_name) : null,
        l.days_at_stage != null ? h('div', { class: 'muted', style: { fontSize: '.78rem', color: l.stalled ? '#dc2626' : '#6b7280' } },
          '⏱ ' + l.days_at_stage + 'd' + (l.stalled ? ' · STALLED (>' + col.stage.expected_days + 'd)' : '')) : null
      ));
    });
    wrap.appendChild(colWrap);
  });
  listEl.innerHTML = '';
  listEl.appendChild(wrap);
};

VIEWS.targets = async (view) => {
  const isAdmin = ['admin', 'manager'].includes(CRM.user.role);
  const isManagerOrUp = ['admin', 'manager', 'team_leader'].includes(CRM.user.role);
  const filtersState = JSON.parse(localStorage.getItem('crm_targets_view') || '{}');
  const monthInput = filtersState.month || new Date().toISOString().slice(0, 7);
  const scopeState = filtersState.scope || (isAdmin ? '' : String(CRM.user.id));

  view.innerHTML = '';

  // ---- Toolbar -------------------------------------------------------
  const monthSel = h('input', { type: 'month', value: monthInput, style: { width: '160px' } });
  const scopeSel = h('select', { id: 'tg-scope' });
  scopeSel.appendChild(h('option', { value: '' }, '🏢 Org-wide'));
  (CRM.cache.users || []).filter(u => isManagerOrUp || Number(u.id) === Number(CRM.user.id)).forEach(u => {
    scopeSel.appendChild(h('option', { value: String(u.id), selected: String(u.id) === scopeState ? 'selected' : null }, u.name));
  });
  if (scopeState) scopeSel.value = scopeState;

  monthSel.addEventListener('change', () => {
    filtersState.month = monthSel.value;
    localStorage.setItem('crm_targets_view', JSON.stringify(filtersState));
    refresh();
  });
  scopeSel.addEventListener('change', () => {
    filtersState.scope = scopeSel.value;
    localStorage.setItem('crm_targets_view', JSON.stringify(filtersState));
    refresh();
  });

  const toolbar = h('div', { class: 'toolbar' },
    h('label', { class: 'muted', style: { marginRight: '4px' } }, 'Month'),
    monthSel,
    h('label', { class: 'muted', style: { marginLeft: '8px', marginRight: '4px' } }, 'Scope'),
    scopeSel,
    h('button', { class: 'btn', onclick: refresh }, '🔄'),
    isAdmin ? h('button', { class: 'btn primary', onclick: () => openSetTargetModal(monthSel.value, scopeSel.value, refresh) }, '🎯 Set target') : null
  );
  view.appendChild(toolbar);

  const body = h('div', {});
  view.appendChild(body);

  async function refresh() {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, 'Crunching numbers…'));
    let r;
    try {
      r = await api('api_targets_dashboard', monthSel.value, scopeSel.value || null);
    } catch (e) { body.innerHTML = ''; return body.appendChild(h('div', { class: 'error' }, e.message)); }
    body.innerHTML = '';
    renderDashboard(body, r);
  }
  refresh();
};

function renderDashboard(body, r) {
  const isAdmin = ['admin', 'manager'].includes(CRM.user.role);

  // ---- Header strip --------------------------------------------------
  body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' } },
    h('h2', { style: { margin: 0 } }, '🎯 ' + r.month + ' · ' + r.scope.label),
    h('div', { class: 'muted', style: { fontSize: '.85rem' } },
      r.days_passed + ' of ' + r.days_in_month + ' days passed · ',
      h('strong', { style: { color: 'var(--brand-dark)' } }, r.days_left + ' days left')
    )
  ));

  // ---- Big KPI grid (the metrics product asked for) -----------------
  const kpi = (label, value, sub, color) => h('div', { style: {
    background: color || 'var(--bg-alt)',
    padding: '14px 16px',
    borderRadius: '10px',
    minWidth: '0'
  } },
    h('div', { class: 'muted', style: { fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 } }, label),
    h('div', { style: { fontSize: '1.7rem', fontWeight: 600, marginTop: '4px', lineHeight: '1.1' } }, value),
    sub ? h('div', { class: 'muted', style: { fontSize: '.72rem', marginTop: '4px' } }, sub) : null
  );

  body.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '14px' } },
    kpi('Target', _tInr(r.target_revenue),
      r.target_revenue ? null : 'Not set yet — admin can set above',
      'var(--brand-soft)'),
    kpi('Revenue Achieved', _tInr(r.revenue_achieved), r.won_leads + ' deals closed', 'var(--ok-soft)'),
    kpi('Target Remaining', _tInr(r.target_remaining), 'a.k.a. Revenue Left', 'var(--warn-soft)'),
    kpi('Days Left', r.days_left, r.days_in_month + '-day month'),
    kpi('Required Daily', _tInr(r.required_daily_target), r.days_left > 0 ? 'to hit target' : 'month closed'),
    kpi('Achievement %',
      r.achievement_pct == null ? '—' : (r.achievement_pct + '%'),
      r.achievement_pct == null ? 'set a target to see' : null,
      r.achievement_pct == null ? 'var(--bg-alt)' : (r.achievement_pct >= 100 ? 'var(--ok-soft)' : r.achievement_pct >= 60 ? 'var(--warn-soft)' : 'var(--err-soft)')),
    kpi('Forecasted Revenue', _tInr(r.forecast_revenue),
      r.forecast_vs_target_pct != null ? (r.forecast_vs_target_pct + '% of target') : 'pace × days in month'),
    kpi('Conversion Rate', _tPct(r.conversion_rate),
      r.new_leads + ' new · ' + r.won_leads + ' won', 'var(--brand-soft)')
  ));

  // ---- Achievement progress bar -------------------------------------
  if (r.achievement_pct != null) {
    const pct = Math.min(100, Math.max(0, r.achievement_pct));
    body.appendChild(h('div', { style: { marginBottom: '18px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '.8rem', marginBottom: '4px' } },
        h('span', { class: 'muted' }, _tInr(r.revenue_achieved) + ' of ' + _tInr(r.target_revenue)),
        h('span', {}, h('strong', {}, _tPct(r.achievement_pct)))
      ),
      h('div', { style: { height: '14px', background: 'var(--bg-alt)', borderRadius: '7px', overflow: 'hidden' } },
        h('div', { style: {
          width: pct + '%', height: '100%',
          background: r.achievement_pct >= 100 ? 'var(--ok)' : r.achievement_pct >= 60 ? 'var(--warn)' : 'var(--err)',
          transition: 'width .4s'
        } })
      )
    ));
  }

  // ---- Weekly Trend chart -------------------------------------------
  if (r.weekly_trend && r.weekly_trend.length) {
    body.appendChild(h('h3', { style: { marginTop: '12px', marginBottom: '6px' } }, 'Weekly trend'));
    const wrap = h('div', { class: 'chart-wrap', style: { height: '220px', marginBottom: '20px' } });
    const canvas = h('canvas');
    wrap.appendChild(canvas);
    body.appendChild(wrap);
    setTimeout(() => {
      // eslint-disable-next-line no-undef
      const ctx = canvas.getContext('2d');
      // eslint-disable-next-line no-undef
      new Chart(ctx, {
        type: 'bar',
        data: {
          labels: r.weekly_trend.map(w => w.week_start),
          datasets: [
            { label: 'Revenue', data: r.weekly_trend.map(w => Math.round(w.revenue)), backgroundColor: '#10b981', yAxisID: 'y' },
            { label: 'Leads in', data: r.weekly_trend.map(w => w.leads), backgroundColor: '#6366f1', type: 'line', borderColor: '#6366f1', tension: .3, yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            y:  { beginAtZero: true, position: 'left', ticks: { callback: v => _tInr(v) } },
            y1: { beginAtZero: true, position: 'right', grid: { display: false }, title: { display: true, text: 'Leads' } }
          }
        }
      });
    }, 10);
  }

  // ---- Funnel conversion --------------------------------------------
  if (r.funnel && r.funnel.length) {
    body.appendChild(h('h3', { style: { marginTop: '12px', marginBottom: '6px' } }, 'Funnel conversion'));
    body.appendChild(h('p', { class: 'muted', style: { fontSize: '.78rem', marginTop: 0, marginBottom: '8px' } },
      'Leads created in ' + r.month + ', currently in each stage. Drop-off is computed against the previous stage.'));
    const fTable = h('table', { class: 'leads-table', style: { fontSize: '.85rem' } },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Stage'),
        h('th', { style: { textAlign: 'right' } }, 'Count'),
        h('th', { style: { textAlign: 'right' } }, '% of total'),
        h('th', { style: { textAlign: 'right' } }, 'Drop-off vs previous')
      )),
      h('tbody', {}, ...r.funnel.map(f => h('tr', {},
        h('td', {}, h('span', { class: 'tag', style: { background: f.color || 'var(--bg-alt)', color: '#fff' } }, f.name)),
        h('td', { style: { textAlign: 'right', fontWeight: 500 } }, f.count),
        h('td', { style: { textAlign: 'right' } }, _tPct(f.pct_of_total)),
        h('td', { style: { textAlign: 'right', color: f.drop_pct != null && f.drop_pct > 0 ? 'var(--err)' : 'var(--text-soft)' } },
          f.drop_pct == null ? '—' : ('-' + Math.round(f.drop_pct) + '%'))
      )))
    );
    body.appendChild(fTable);
  }

  // ---- Per-rep breakdown (org-wide view only) -----------------------
  if (r.rep_breakdown && r.rep_breakdown.length) {
    body.appendChild(h('h3', { style: { marginTop: '20px', marginBottom: '6px' } }, 'Per-rep performance'));
    const repTable = h('table', { class: 'leads-table', style: { fontSize: '.85rem' } },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Rep'),
        h('th', { style: { textAlign: 'right' } }, 'Revenue'),
        h('th', { style: { textAlign: 'right' } }, 'Target'),
        h('th', { style: { textAlign: 'right' } }, 'Achievement'),
        h('th', { style: { textAlign: 'right' } }, 'New'),
        h('th', { style: { textAlign: 'right' } }, 'Won'),
        h('th', { style: { textAlign: 'right' } }, 'Conv. %')
      )),
      h('tbody', {}, ...r.rep_breakdown.map(rep => h('tr', {},
        h('td', {}, rep.name),
        h('td', { style: { textAlign: 'right', fontWeight: 500 } }, _tInr(rep.revenue_achieved)),
        h('td', { style: { textAlign: 'right' } }, rep.target_revenue ? _tInr(rep.target_revenue) : '—'),
        h('td', { style: { textAlign: 'right' } },
          rep.achievement_pct == null
            ? h('span', { class: 'muted' }, '—')
            : h('span', { class: 'tag', style: {
                background: rep.achievement_pct >= 100 ? 'var(--ok-soft)' : rep.achievement_pct >= 60 ? 'var(--warn-soft)' : 'var(--err-soft)',
                color:      rep.achievement_pct >= 100 ? 'var(--ok)'      : rep.achievement_pct >= 60 ? 'var(--warn)'      : 'var(--err)'
              } }, _tPct(rep.achievement_pct))
        ),
        h('td', { style: { textAlign: 'right' } }, rep.new_leads),
        h('td', { style: { textAlign: 'right' } }, rep.won_leads),
        h('td', { style: { textAlign: 'right' } }, _tPct(rep.conversion_rate))
      )))
    );
    body.appendChild(repTable);
  }
}

/**
 * Modal for admin/manager to set / edit a monthly target. user_id = ''
 * means org-wide; a numeric value means a specific rep.
 */
async function openSetTargetModal(month, userId, onDone) {
  let existing = null;
  try { existing = await api('api_targets_get', month, userId || null); }
  catch (e) { /* ignore */ }
  const e = existing || {};
  const userField = h('select', { id: 'tg-user' });
  userField.appendChild(h('option', { value: '', selected: !userId ? 'selected' : null }, '🏢 Org-wide target'));
  (CRM.cache.users || []).forEach(u => userField.appendChild(h('option', { value: String(u.id), selected: String(u.id) === String(userId) ? 'selected' : null }, u.name)));

  const monthField = h('input', { type: 'month', value: month || new Date().toISOString().slice(0, 7) });
  const revInput = h('input', { type: 'number', step: '0.01', min: '0', value: e.target_revenue || '' });
  const leadsInput = h('input', { type: 'number', min: '0', value: e.target_leads || '' });
  const salesInput = h('input', { type: 'number', min: '0', value: e.target_sales || '' });
  const callsInput = h('input', { type: 'number', min: '0', value: e.target_calls || '' });
  const notesInput = h('textarea', { rows: 2 }, e.notes || '');

  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('div', { class: 'modal-head' },
      h('h3', {}, '🎯 Set monthly target'),
      h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
    ),
    h('div', { class: 'form-grid' },
      h('div', { class: 'f-row' }, h('label', {}, 'Month'), monthField),
      h('div', { class: 'f-row' }, h('label', {}, 'Scope'), userField),
      h('div', { class: 'f-row' }, h('label', {}, 'Target revenue (₹)'), revInput),
      h('div', { class: 'f-row' }, h('label', {}, 'Target new leads'), leadsInput),
      h('div', { class: 'f-row' }, h('label', {}, 'Target sales count'), salesInput),
      h('div', { class: 'f-row' }, h('label', {}, 'Target calls'), callsInput),
      h('div', { class: 'f-row full' }, h('label', {}, 'Notes'), notesInput)
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          await api('api_targets_save', {
            month: monthField.value,
            user_id: userField.value || null,
            target_revenue: Number(revInput.value) || 0,
            target_leads:   Number(leadsInput.value) || 0,
            target_sales:   Number(salesInput.value) || 0,
            target_calls:   Number(callsInput.value) || 0,
            notes: notesInput.value
          });
          toast('Target saved');
          modal.remove();
          if (onDone) onDone();
        } catch (e) { toast(e.message, 'err'); }
      } }, 'Save target')
    )
  ));
  document.body.appendChild(modal);
}

/**
 * Call ratings report — rep-wise call quality summary.
 * Shows total calls, rated calls, manual avg, AI-suggested avg, and a
 * 1★→5★ distribution bar per rep. Supports date range + user filter.
 */
/**
 * AI usage report — month-to-date Gemini cost + per-rep breakdown.
 * Shows actual cost (vendor) and billable cost (with markup).
 * Plus a cost estimator that converts X minutes → ₹.
 */
/**
 * Call Insights — showcase view of AI call analysis.
 * Scrollable feed of every recent call with AI summary, action items,
 * sentiment, suggested status — across all leads + reps.
 */
VIEWS.callinsights = async (view) => {
  view.innerHTML = '';
  const out = h('div', {});
  view.appendChild(out);
  const sentSel = h('select', {},
    h('option', { value: '' }, 'All sentiments'),
    h('option', { value: 'positive' }, '😊 Positive'),
    h('option', { value: 'neutral' }, '😐 Neutral'),
    h('option', { value: 'negative' }, '😟 Negative')
  );
  const userSel = h('select', {},
    h('option', { value: '' }, 'All reps'),
    ...((CRM.cache.users || []).map(u => h('option', { value: u.id }, u.name)))
  );
  const feedDiv = h('div', { class: 'insights-feed' });

  async function load() {
    feedDiv.innerHTML = '<div class="muted">Loading…</div>';
    const opts = { limit: 100 };
    if (sentSel.value) opts.sentiment = sentSel.value;
    if (userSel.value) opts.userId = userSel.value;
    try {
      const rows = await api('api_recording_recentInsights', opts);
      if (rows && rows.error) { feedDiv.innerHTML = '<div class="ai-error">' + esc(rows.error) + '</div>'; return; }
      if (!rows || rows.length === 0) {
        feedDiv.innerHTML = '<div class="muted">No call recordings yet. Once your team starts uploading recordings, AI summaries will appear here.</div>';
        return;
      }
      feedDiv.innerHTML = '';
      const total = rows.length;
      const pos = rows.filter(r => r.sentiment === 'positive').length;
      const neg = rows.filter(r => r.sentiment === 'negative').length;
      const totalMin = Math.round(rows.reduce((s, r) => s + (r.duration_s || 0), 0) / 60);
      feedDiv.appendChild(h('div', { class: 'cards', style: 'margin-bottom:1rem' },
        kpiCard('🎙 Calls analysed', total, totalMin + ' min total', 'accent'),
        kpiCard('😊 Positive',  pos + ' (' + Math.round(pos/total*100) + '%)', 'Strong intent', 'ok'),
        kpiCard('😟 Negative',  neg + ' (' + Math.round(neg/total*100) + '%)', 'Need review', 'warn'),
        kpiCard('🤖 AI accuracy', '~95%', 'Hindi-English code-mix', 'accent')
      ));
      rows.forEach(r => feedDiv.appendChild(insightCard(r)));
    } catch (e) {
      feedDiv.innerHTML = '<div class="ai-error">Could not load: ' + esc(e.message) + '</div>';
    }
  }

  function insightCard(r) {
    const sentColor = { positive: '#10b981', neutral: '#64748b', negative: '#ef4444' }[r.sentiment] || '#64748b';
    const sentLabel = { positive: '😊', neutral: '😐', negative: '😟' }[r.sentiment] || '·';
    const dur = Number(r.duration_s) || 0;
    const mm = Math.floor(dur / 60), ss = (dur % 60).toString().padStart(2, '0');
    return h('div', { class: 'card insight-card' },
      h('div', { class: 'insight-header' },
        h('div', {},
          h('a', { href: '#/leads', onclick: e => { e.preventDefault(); openLeadModal(r.lead_id); } },
            h('b', {}, r.lead_name || r.phone || '—')
          ),
          h('span', { class: 'muted' }, ' · ' + (r.rep_name || '—') + ' · ' + mm + ':' + ss + ' · ' + fmtDate(r.created_at, 'relative'))
        ),
        h('div', {},
          h('span', { class: 'ai-sentiment-pill', style: 'background:' + sentColor }, sentLabel + ' ' + (r.sentiment || '—')),
          r.ai_suggested_rating ? h('span', { class: 'ai-rating-pill', title: 'AI rating' }, '🤖 ' + r.ai_suggested_rating + '/5') : null,
          r.rating ? h('span', { class: 'ai-rating-pill', style: 'background:#fef3c7;color:#92400e' }, '★ ' + r.rating + '/5') : null
        )
      ),
      h('div', { class: 'insight-summary' }, r.summary || '—'),
      r.key_insight ? h('div', { class: 'insight-key' }, '💡 ' + r.key_insight) : null,
      r.action_items && r.action_items.length > 0
        ? h('div', { class: 'insight-actions' }, h('span', { class: 'insight-actions-title' }, '✓ Next steps:'), ' ', r.action_items.slice(0, 3).join(' · '))
        : null,
      r.suggested_status_name && r.suggested_status_name !== r.lead_status_name
        ? h('div', { class: 'insight-suggest' }, '🎯 AI suggests status: ', h('b', {}, r.suggested_status_name),
            r.next_followup_days != null ? ' · follow up in ' + r.next_followup_days + ' day(s)' : null)
        : null
    );
  }

  view.appendChild(h('div', { class: 'card' },
    h('h3', {}, '🎙 Call Insights — every call, AI-analysed'),
    h('p', { class: 'muted' }, 'Each call recording is automatically transcribed + summarised by AI. Click any lead below to see the full transcript.')
  ));
  view.appendChild(h('div', { class: 'toolbar' },
    h('span', {}, 'Filter:'), sentSel, userSel,
    h('button', { class: 'btn primary', onclick: load }, '🔎 Apply')
  ));
  view.appendChild(feedDiv);
  load();
};

VIEWS.aiusage = async (view) => {
  view.innerHTML = '';
  const out = h('div', {});
  view.appendChild(out);
  out.innerHTML = '<div class="muted">Loading AI usage…</div>';
  try {
    const u = await api('api_reports_aiUsage', {});
    if (u.error) { out.innerHTML = '<div class="ai-error">' + esc(u.error) + '</div>'; return; }
    out.innerHTML = '';
    const m = u.this_month || {}, a = u.all_time || {};
    out.appendChild(h('div', { class: 'cards', style: 'margin-bottom:1rem' },
      kpiCard('💸 This month', '₹' + (m.cost_inr_billable || 0).toFixed(2), 'Total AI transcription cost', 'accent'),
      kpiCard('📞 Calls analysed', m.calls || 0, (m.audio_minutes || 0) + ' min audio processed', 'ok'),
      kpiCard('📈 Forecast', '₹' + (u.forecast_monthly_inr || 0).toFixed(0), 'Projected monthly cost @ current pace', 'warn'),
      kpiCard('🔢 All-time', '₹' + (a.cost_inr_billable || 0).toFixed(2), a.calls + ' calls · ' + a.audio_minutes + ' min total', 'accent')
    ));
    const perMinInr = m.audio_minutes > 0 ? (m.cost_inr_billable / m.audio_minutes) : 0;
    const perCallInr = m.calls > 0 ? (m.cost_inr_billable / m.calls) : 0;
    out.appendChild(h('div', { class: 'card' },
      h('h3', {}, '📊 This month — ' + u.month),
      h('table', { class: 'mini-table' }, h('tbody', {},
        row('Calls analysed', m.calls),
        row('Audio processed', (m.audio_minutes || 0) + ' minutes'),
        row('Average per minute', '₹' + perMinInr.toFixed(3)),
        row('Average per call', '₹' + perCallInr.toFixed(2)),
        row('Total cost', h('b', { style: 'color:#10b981;font-size:16px' }, '₹' + (m.cost_inr_billable || 0).toFixed(2)))
      ))
    ));
    if (u.by_user && u.by_user.length > 0) {
      const tbl = h('table', { class: 'call-rating-report' });
      tbl.appendChild(h('thead', {}, h('tr', {},
        h('th', {}, 'Rep'),
        h('th', { style: 'text-align:right' }, 'Calls'),
        h('th', { style: 'text-align:right' }, 'Audio (min)'),
        h('th', { style: 'text-align:right' }, 'Cost')
      )));
      const tb = h('tbody', {});
      tbl.appendChild(tb);
      u.by_user.forEach(ru => tb.appendChild(h('tr', {},
        h('td', {}, h('b', {}, ru.user_name)),
        h('td', { style: 'text-align:right' }, ru.calls),
        h('td', { style: 'text-align:right' }, ru.audio_minutes),
        h('td', { style: 'text-align:right;color:#10b981;font-weight:600' }, '₹' + ru.cost_inr_billable.toFixed(2))
      )));
      out.appendChild(h('div', { class: 'card call-rating-report' }, h('h3', {}, '👥 By rep — this month'), tbl));
    }
    const estCard = h('div', { class: 'card' });
    estCard.appendChild(h('h3', {}, '🧮 Cost estimator'));
    estCard.appendChild(h('p', { class: 'muted' }, 'Forecast what N minutes of AI call analysis will cost.'));
    const minsInp = h('input', { type: 'number', value: 100, min: 1, step: 10, style: 'width:100px' });
    const callMinInp = h('input', { type: 'number', value: 5, min: 0.5, step: 0.5, style: 'width:80px' });
    const estOut = h('div', { style: 'margin-top:12px' });
    estCard.appendChild(h('div', { class: 'toolbar' },
      h('span', {}, 'Total minutes:'), minsInp,
      h('span', {}, 'Avg call (min):'), callMinInp,
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await api('api_reports_aiCostEstimator', { minutes: Number(minsInp.value), avgCallMinutes: Number(callMinInp.value) });
          estOut.innerHTML = '';
          estOut.appendChild(h('div', { class: 'cards' },
            kpiCard('💰 Total cost', '₹' + r.cost_inr_billable.toFixed(2), 'For ' + r.minutes + ' min · ~' + r.calls + ' calls', 'ok'),
            kpiCard('Per minute', '₹' + r.per_minute_inr_billable.toFixed(3), '', 'warn'),
            kpiCard('Per call', '₹' + r.per_call_inr_billable.toFixed(3), '@ ' + r.avg_call_minutes + ' min/call', 'accent')
          ));
          const exTbl = h('table', { class: 'mini-table', style: 'margin-top:1rem' });
          exTbl.appendChild(h('thead', {}, h('tr', {},
            h('th', {}, 'Volume'), h('th', { style: 'text-align:right' }, 'Cost (₹)')
          )));
          const exB = h('tbody', {});
          exTbl.appendChild(exB);
          (r.examples || []).forEach(e => exB.appendChild(h('tr', {},
            h('td', {}, e.label),
            h('td', { style: 'text-align:right;color:#10b981;font-weight:600' }, '₹' + e.cost_inr_billable.toFixed(2))
          )));
          estOut.appendChild(h('h4', { style: 'margin-top:1rem' }, 'Quick reference'));
          estOut.appendChild(exTbl);
        } catch (e) { estOut.innerHTML = '<div class="ai-error">' + esc(e.message) + '</div>'; }
      } }, '🔢 Calculate')
    ));
    estCard.appendChild(estOut);
    out.appendChild(estCard);
  } catch (e) { out.innerHTML = '<div class="ai-error">Could not load: ' + esc(e.message) + '</div>'; }
};


// Helper for KPI cards in AI usage view (avoids polluting global card())
function kpiCard(label, value, sub, klass) {
  return h('div', { class: 'card kpi ' + (klass || '') },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, value),
    sub ? h('div', { class: 'kpi-sub muted' }, sub) : null
  );
}
function row(label, value) {
  return h('tr', {}, h('td', { class: 'muted' }, label), h('td', {}, value));
}

VIEWS.callratings = async (view) => {
  view.innerHTML = '';
  const { users = [] } = CRM.cache;
  const fromInp = h('input', { type: 'date' });
  const toInp   = h('input', { type: 'date' });
  const userSel = h('select', {},
    h('option', { value: '' }, 'All users'),
    ...users.map(u => h('option', { value: u.id }, u.name))
  );
  const out = h('div', { class: 'call-rating-report' });

  async function load() {
    out.innerHTML = '<div class="muted">Loading…</div>';
    const filters = {};
    if (fromInp.value) filters.from = fromInp.value + 'T00:00:00';
    if (toInp.value)   filters.to   = toInp.value   + 'T23:59:59';
    if (userSel.value) filters.userId = userSel.value;
    try {
      const rows = await api('api_reports_callRatingByUser', filters);
      if (rows && rows.error) {
        out.innerHTML = '<div class="ai-error">' + esc(rows.error) + '</div>';
        return;
      }
      if (!rows || rows.length === 0) {
        out.innerHTML = '<div class="muted">No call recordings in this range.</div>';
        return;
      }
      out.innerHTML = '';
      const tbl = h('table', {},
        h('thead', {},
          h('tr', {},
            h('th', {}, 'Rep'),
            h('th', { style: 'text-align:right' }, 'Total calls'),
            h('th', { style: 'text-align:right' }, 'Rated'),
            h('th', { style: 'text-align:right' }, 'Avg ★'),
            h('th', { style: 'text-align:right' }, 'AI avg'),
            h('th', {}, '1★ 2★ 3★ 4★ 5★'),
            h('th', {}, 'Last call')
          )
        )
      );
      const tb = h('tbody', {});
      tbl.appendChild(tb);
      rows.forEach(r => {
        const stars = (n, color) => {
          if (n == null) return h('span', { class: 'muted' }, '—');
          return h('span', { style: 'color:' + (color || '#f59e0b'), fontWeight: 600 },
            n.toFixed(1) + ' ' + '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n))
          );
        };
        tb.appendChild(h('tr', {},
          h('td', {}, h('b', {}, r.user_name || '—'),
            r.user_role ? h('span', { class: 'muted' }, ' · ' + r.user_role) : null),
          h('td', { style: 'text-align:right' }, h('span', { class: 'num-pill' }, r.total_calls)),
          h('td', { style: 'text-align:right' }, r.rated_calls),
          h('td', { style: 'text-align:right' }, stars(r.avg_rating)),
          h('td', { style: 'text-align:right' }, stars(r.avg_ai_rating, '#94a3b8')),
          h('td', {},
            h('span', { class: 'num-pill', style: 'background:#fee2e2;color:#991b1b' }, r.r1 || 0),
            ' ',
            h('span', { class: 'num-pill', style: 'background:#fed7aa;color:#9a3412' }, r.r2 || 0),
            ' ',
            h('span', { class: 'num-pill', style: 'background:#fef08a;color:#713f12' }, r.r3 || 0),
            ' ',
            h('span', { class: 'num-pill', style: 'background:#bbf7d0;color:#14532d' }, r.r4 || 0),
            ' ',
            h('span', { class: 'num-pill', style: 'background:#86efac;color:#14532d' }, r.r5 || 0)
          ),
          h('td', { class: 'muted' }, r.last_call_at ? fmtDate(r.last_call_at, 'relative') : '—')
        ));
      });
      out.appendChild(tbl);
    } catch (e) {
      out.innerHTML = '<div class="ai-error">Could not load: ' + esc(e.message) + '</div>';
    }
  }

  view.appendChild(h('div', { class: 'toolbar' },
    h('span', {}, 'From'), fromInp,
    h('span', {}, 'to'), toInp,
    h('span', {}, 'User'), userSel,
    h('button', { class: 'btn primary', onclick: load }, '🔎 Apply')
  ));
  view.appendChild(h('div', { class: 'card' },
    h('h3', {}, '⭐ Call ratings — rep-wise'),
    h('p', { class: 'muted' }, 'Manual ratings are 1-5 stars set by the rep or manager on each recording. AI-suggested ratings come from Gemini\'s call analysis. Use the rating panel on any recording to set / change a manual rating.'),
    out
  ));
  load();
};

VIEWS.tatreport = async (view) => {
  view.innerHTML = '';
  const { users = [] } = CRM.cache;
  const fromInp = h('input', { type: 'date' });
  const toInp   = h('input', { type: 'date' });
  const userSel = h('select', {},
    h('option', { value: '' }, 'All users'),
    ...users.map(u => h('option', { value: u.id }, u.name))
  );
  const out = h('div', {});
  const fmtMin = m => m == null ? '—' : (m < 60 ? m + ' min' : (m / 60 < 24 ? (m / 60).toFixed(1) + ' hr' : (m / 1440).toFixed(1) + ' days'));
  const fmtSec = s => s == null ? '—' : fmtMin(Math.round(s / 60));
  async function load() {
    out.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const r = await api('api_tat_report', { from: fromInp.value || undefined, to: toInp.value || undefined, user_id: userSel.value || undefined });
      out.innerHTML = '';

      // KPI cards
      out.appendChild(h('div', { class: 'cards' },
        h('div', { class: 'card stat accent' }, h('div', { class: 'stat-icon' }, '🎯'), h('div', { class: 'stat-body' }, h('div', { class: 'stat-label' }, 'Leads'), h('div', { class: 'stat-value' }, r.totals.leads))),
        h('div', { class: 'card stat ok' },     h('div', { class: 'stat-icon' }, '⚡'), h('div', { class: 'stat-body' }, h('div', { class: 'stat-label' }, 'Avg time to 1st action'), h('div', { class: 'stat-value' }, fmtMin(r.totals.avg_first_min)))),
        h('div', { class: 'card stat err' },    h('div', { class: 'stat-icon' }, '🚨'), h('div', { class: 'stat-body' }, h('div', { class: 'stat-label' }, 'Open violations'), h('div', { class: 'stat-value' }, r.open_violations)))
      ));

      // By user
      out.appendChild(h('div', { class: 'card card-wide' },
        h('h3', {}, 'By user — avg response time'),
        r.by_user.length === 0 ? h('p', { class: 'muted' }, 'No data in scope.') :
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Leads'), h('th', {}, 'Actioned'), h('th', {}, 'Avg → 1st action'), h('th', {}, 'Avg → 2nd action'))),
          h('tbody', {}, ...r.by_user.map(u => h('tr', {},
            h('td', {}, u.user_name || '—'),
            h('td', {}, u.leads),
            h('td', {}, u.actioned + ' / ' + u.leads),
            h('td', {}, fmtMin(u.avg_first_min)),
            h('td', {}, fmtMin(u.avg_second_min))
          )))
        ))
      ));

      // By stage
      out.appendChild(h('div', { class: 'card card-wide' },
        h('h3', {}, 'By stage — avg time leads spend before moving on'),
        r.by_stage.length === 0 ? h('p', { class: 'muted' }, 'No completed stage transitions yet. (Move some leads through stages and this will populate.)') :
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', {}, 'Transitions'), h('th', {}, 'Avg minutes in stage'))),
          h('tbody', {}, ...r.by_stage.map(s => h('tr', {},
            h('td', {}, s.status_name),
            h('td', {}, s.transitions),
            h('td', {}, fmtMin(s.avg_minutes))
          )))
        ))
      ));

      // Active violations
      out.appendChild(h('div', { class: 'card card-wide' },
        h('h3', {}, '🚨 Active TAT violations'),
        r.open_violation_rows.length === 0 ? h('p', { class: 'muted' }, 'No open violations. 🎉') :
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Lead'), h('th', {}, 'Stage'), h('th', {}, 'Owner'), h('th', {}, 'Threshold'), h('th', {}, 'Triggered'), h('th', {}, 'Escalation'))),
          h('tbody', {}, ...r.open_violation_rows.map(v => h('tr', {},
            h('td', {}, h('a', { href: '#', onclick: ev => { ev.preventDefault(); openLeadModal(v.lead_id); } }, v.lead_name || ('Lead #' + v.lead_id))),
            h('td', {}, v.status_name),
            h('td', {}, v.user_name || '—'),
            h('td', {}, v.threshold_minutes + ' min'),
            h('td', {}, fmtDate(v.triggered_at, 'relative')),
            h('td', {}, v.escalation_level === 3 ? '🚨 Admin (L3)' : v.escalation_level === 2 ? '⚠️ Manager (L2)' : '⏱️ Employee (L1)')
          )))
        ))
      ));
    } catch (e) {
      out.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    }
  }
  view.append(
    h('div', { class: 'toolbar' },
      h('span', {}, 'From'), fromInp,
      h('span', {}, 'to'), toInp,
      userSel,
      h('button', { class: 'btn primary', onclick: load }, '🔎 Apply')
    ),
    out
  );
  await load();
};

VIEWS.reports = async (view) => {
  await ensureChartJs();
  view.innerHTML = '';
  const { users = [], products = [], sources = [], statuses = [] } = CRM.cache;
  const filterBar = h('div', { class: 'toolbar' },
    h('input', { type: 'date', id: 'rep-from' }),
    h('span', {}, 'to'),
    h('input', { type: 'date', id: 'rep-to' }),
    selectOpts('rep-user', [{ id: '', name: 'All users' }, ...users]),
    h('select', { id: 'rep-role' },
      h('option', { value: '' }, 'Any role'),
      h('option', { value: 'admin' }, 'Admin'),
      h('option', { value: 'manager' }, 'Manager'),
      h('option', { value: 'team_leader' }, 'Team leader'),
      h('option', { value: 'sales' }, 'Tele-caller / Sales')
    ),
    // ---- Lead-field filters ------------------------------------
    h('select', { id: 'rep-status' },
      h('option', { value: '' }, 'Any status'),
      ...statuses.map(s => h('option', { value: s.id }, s.name))
    ),
    h('select', { id: 'rep-product' },
      h('option', { value: '' }, 'Any product'),
      ...products.map(p => h('option', { value: p.id }, p.name))
    ),
    selectOpts('rep-source', [{ id: '', name: 'Any source' }, ...sources.map(s => ({ id: s.name, name: s.name }))]),
    h('select', { id: 'rep-qualified' },
      h('option', { value: '' }, 'Any qualified'),
      h('option', { value: '1' }, 'Qualified only'),
      h('option', { value: '0' }, 'Not qualified')
    ),
    h('input', { id: 'rep-tag', placeholder: 'Tag (e.g. vip)', style: { maxWidth: '130px' } }),
    h('button', { class: 'btn primary', onclick: loadReports }, '🔎 Apply'),
    h('button', { class: 'btn', onclick: downloadReportExcel, title: 'Export filtered leads as Excel (XLSX)' }, '📊 Export Excel'),
    h('button', { class: 'btn', onclick: downloadReportCsv, title: 'Export filtered leads as CSV' }, '⬇️ CSV')
  );
  view.appendChild(filterBar);
  view.appendChild(h('div', { id: 'rep-cards', class: 'cards' }));
  view.appendChild(h('div', { class: 'chart-grid' },
    h('div', { class: 'card' }, h('h3', {}, 'By status'), h('div', { class: 'chart-wrap' }, h('canvas', { id: 'chart-status' }))),
    h('div', { class: 'card' }, h('h3', {}, 'By source'), h('div', { class: 'chart-wrap' }, h('canvas', { id: 'chart-source' }))),
    h('div', { class: 'card' }, h('h3', {}, 'By product'), h('div', { class: 'chart-wrap' }, h('canvas', { id: 'chart-product' }))),
    h('div', { class: 'card card-wide' }, h('h3', {}, 'Lead funnel'), h('div', { id: 'chart-funnel-wrap', class: 'rfun-wrap' })),
    h('div', { class: 'card card-wide' },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.5rem', flexWrap: 'wrap', gap: '.5rem' } },
        h('h3', { style: { margin: 0 } }, 'By date'),
        h('button', { class: 'btn sm ghost', id: 'rep-daily-csv', title: 'Download daily breakdown as CSV' }, '⬇️ CSV')
      ),
      h('div', { class: 'chart-wrap', style: { height: '220px' } }, h('canvas', { id: 'chart-daily' })),
      h('div', { id: 'rep-daily-table', style: { marginTop: '1rem' } })
    ),
    h('div', { class: 'card card-wide' }, h('h3', {}, 'By user'), h('div', { id: 'rep-by-user' }))
  ));
  await loadReports();
};

/**
 * Read the current report filter bar into a plain object. Centralised so the
 * Apply button, the Excel export, and the CSV export all agree on what
 * "current filters" means — otherwise the export could silently disagree with
 * the on-screen charts (a classic source of "but the numbers don't match!").
 */
function _currentReportFilters() {
  const from = $('#rep-from')?.value || undefined;
  const to   = $('#rep-to')?.value || undefined;
  const user = $('#rep-user')?.value || undefined;
  const role = $('#rep-role')?.value || undefined;
  const status_id = $('#rep-status')?.value || undefined;
  const product_id = $('#rep-product')?.value || undefined;
  const source = $('#rep-source')?.value || undefined;
  const qualified = $('#rep-qualified')?.value || undefined;
  const tag = $('#rep-tag')?.value || undefined;
  return { from, to, scope_user_id: user, role, status_id, product_id, source, qualified, tag };
}

async function loadReports() {
  const filters = _currentReportFilters();
  // Caller-wise follow-up + TAT-violation tables are intentionally NOT
  // date-filtered — "overdue" / "due today" / "open violation" are NOW
  // concepts, not historical. So they ignore the date range filter and
  // always show live counts for every visible rep.
  const [summary, funnel, daily, teamFu, teamTat] = await Promise.all([
    api('api_reports_summary', filters),
    api('api_reports_funnel',  filters),
    api('api_reports_daily',   filters),
    api('api_reports_followupsByUser').catch(() => []),
    api('api_reports_tatViolationsByUser').catch(() => [])
  ]);

  $('#rep-cards').innerHTML = '';
  [['Total', summary.totals.total, 'accent'], ['New', summary.totals.new_leads, ''], ['Won', summary.totals.won, 'ok'], ['Lost', summary.totals.lost, 'err']].forEach(([label, val, klass]) => {
    $('#rep-cards').appendChild(h('div', { class: `card stat ${klass}` },
      h('div', { class: 'stat-body' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, val || 0))
    ));
  });

  // "By status" is now a bar chart with visible numbers — easier to read and
  // compare than a doughnut, especially with many statuses.
  makeChart('chart-status', 'bar',
    (summary.by_status || []).map(x => x.status),
    (summary.by_status || []).map(x => x.c),
    (summary.by_status || []).map(x => x.color));
  makeChart('chart-source', 'bar',
    (summary.by_source || []).map(x => x.source),
    (summary.by_source || []).map(x => x.c));
  // "By product" — same bar style. Backend already sorts DESC so the biggest
  // product reads first. Drives top-of-mind for "what are we actually selling".
  makeChart('chart-product', 'bar',
    (summary.by_product || []).map(x => x.product),
    (summary.by_product || []).map(x => x.c));
  // Funnel: replaced the horizontal-bar chart with a true funnel visual
  // (decreasing-width rows showing both count and conversion-from-top %).
  renderFunnel('chart-funnel-wrap', funnel);

  // ---------- "By date" — daily breakdown chart + table ----------
  renderDailyBreakdown(daily, filters);

  const byUserEl = $('#rep-by-user');
  byUserEl.innerHTML = '';
  if (!summary.by_user.length) { byUserEl.innerHTML = '<p class="muted">No user activity in this period.</p>'; return; }
  byUserEl.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Role'), h('th', {}, 'Total'), h('th', {}, 'New'), h('th', {}, 'Open'), h('th', {}, 'Won'), h('th', {}, 'Lost'))),
    h('tbody', {}, ...summary.by_user.map(u => h('tr', {},
      h('td', {}, u.name), h('td', {}, u.role),
      h('td', {}, u.total), h('td', {}, u.new_leads), h('td', {}, u.open_leads),
      h('td', { class: 'cell-ok' }, u.won), h('td', { class: 'cell-err' }, u.lost)
    )))
  )));

  // Caller-wise follow-up table — live now-counts, NOT date-filtered.
  // Kept on the Reports page as a separate card so a manager looking at a
  // historical date range can still see the current overdue heatmap.
  const teamRows = teamFu || [];
  if (teamRows.length) {
    const card = h('div', { class: 'card card-wide', style: { marginTop: '1rem' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.5rem' } },
        h('h3', { style: { margin: 0 } }, '👥 Follow-ups by caller — live'),
        h('span', { class: 'muted', style: { fontSize: '.78rem' } }, 'Ignores the date range above — shows current open counts')
      ),
      h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Caller'), h('th', {}, 'Role'),
          h('th', { style: { textAlign: 'right' } }, '⚠️ Overdue'),
          h('th', { style: { textAlign: 'right' } }, '📅 Due today'),
          h('th', { style: { textAlign: 'right' } }, '⏰ Upcoming'),
          h('th', { style: { textAlign: 'right' } }, 'Total open')
        )),
        h('tbody', {}, ...teamRows.map(r => h('tr', {},
          h('td', {}, r.name || '—'),
          h('td', { class: 'muted' }, r.role || ''),
          h('td', { class: r.overdue > 0 ? 'cell-err' : 'muted', style: { textAlign: 'right', fontWeight: r.overdue > 0 ? 700 : 400 } }, r.overdue),
          h('td', { class: r.due_today > 0 ? 'cell-warn' : 'muted', style: { textAlign: 'right', fontWeight: r.due_today > 0 ? 700 : 400 } }, r.due_today),
          h('td', { class: 'muted', style: { textAlign: 'right' } }, r.upcoming),
          h('td', { style: { textAlign: 'right', fontWeight: 600 } }, r.total_open)
        )))
      ))
    );
    byUserEl.parentElement.appendChild(card);
  }

  // Caller-wise TAT violations — live, ignoring date filter, same as
  // follow-ups. Splits by escalation level so a manager spots reps with
  // L3 escalations (admin-paged, the most urgent) at the top of the list.
  const tatRows = teamTat || [];
  if (tatRows.length) {
    const card = h('div', { class: 'card card-wide', style: { marginTop: '1rem' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.5rem' } },
        h('h3', { style: { margin: 0 } }, '🚨 TAT violations by caller — live'),
        h('a', { href: '#/tatreport', class: 'btn sm ghost' }, 'See full TAT report →')
      ),
      h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Caller'), h('th', {}, 'Role'),
          h('th', { style: { textAlign: 'right' }, title: 'L3 — escalated to admin' }, '🚨 L3'),
          h('th', { style: { textAlign: 'right' }, title: 'L2 — escalated to manager' }, '⚠️ L2'),
          h('th', { style: { textAlign: 'right' }, title: 'L1 — employee reminder' }, '⏱️ L1'),
          h('th', { style: { textAlign: 'right' } }, 'Total open')
        )),
        h('tbody', {}, ...tatRows.map(r => h('tr', {},
          h('td', {}, r.name || '—'),
          h('td', { class: 'muted' }, r.role || ''),
          h('td', { class: r.l3 > 0 ? 'cell-err' : 'muted', style: { textAlign: 'right', fontWeight: r.l3 > 0 ? 700 : 400 } }, r.l3),
          h('td', { class: r.l2 > 0 ? 'cell-warn' : 'muted', style: { textAlign: 'right', fontWeight: r.l2 > 0 ? 700 : 400 } }, r.l2),
          h('td', { class: 'muted', style: { textAlign: 'right' } }, r.l1),
          h('td', { style: { textAlign: 'right', fontWeight: 600 } }, r.total)
        )))
      ))
    );
    byUserEl.parentElement.appendChild(card);
  }
}

/* --------------------------------------------------------------------
 * Reports section — Excel / CSV export of the filtered leads
 *
 * Both buttons hit `api_reports_exportLeads` with the SAME filter object
 * loadReports() uses, so what you see in the charts is exactly what you
 * download. The Excel path lazy-loads SheetJS (already shipped for the CSV
 * import flow) so the 800kb library only downloads when the user actually
 * clicks the button.
 * -------------------------------------------------------------------- */

// Column definition is shared by both exports so adding a new column shows
// up in CSV and XLSX simultaneously. Order matters — that's the column order
// in the resulting file.
const REPORT_EXPORT_COLUMNS = [
  ['id',               'Lead ID'],
  ['name',             'Name'],
  ['phone',            'Phone'],
  ['whatsapp',         'WhatsApp'],
  ['email',            'Email'],
  ['city',             'City'],
  ['source',           'Source'],
  ['status_name',      'Status'],
  ['product_name',     'Product'],
  ['assigned_name',    'Assigned to'],
  ['qualified',        'Qualified'],
  ['tags',             'Tags'],
  ['gclid',            'GCLID'],
  ['utm_source',       'UTM Source'],
  ['utm_medium',       'UTM Medium'],
  ['utm_campaign',     'UTM Campaign'],
  ['utm_term',         'UTM Term'],
  ['utm_content',      'UTM Content'],
  ['next_followup_at', 'Next Follow-up'],
  ['created_at',       'Created'],
  ['notes',            'Notes']
];

function _buildExportRow(lead) {
  const row = {};
  REPORT_EXPORT_COLUMNS.forEach(([key, header]) => {
    let v = lead[key];
    if (v == null) v = '';
    // Created/follow-up dates: format as IST yyyy-mm-dd hh:mm so Excel
    // doesn't show ugly ISO strings.
    if (key === 'created_at' || key === 'next_followup_at') {
      if (v) {
        try {
          const d = new Date(v);
          if (!isNaN(d)) v = d.toLocaleString('en-IN', { hour12: false });
        } catch (_) {}
      }
    }
    row[header] = v;
  });
  // Flatten interesting custom fields so a "Budget" or "Project type" extra
  // becomes its own column. Prefix with "extra_" to avoid collisions.
  if (lead.extra && typeof lead.extra === 'object') {
    Object.keys(lead.extra).forEach(k => {
      const ek = 'Extra · ' + k;
      if (!(ek in row)) row[ek] = lead.extra[k];
    });
  }
  return row;
}

function _exportFilenameStem(filters) {
  const stamp = new Date().toISOString().slice(0, 10);
  const range = (filters.from || filters.to)
    ? '_' + (filters.from || 'start') + '_to_' + (filters.to || stamp)
    : '_' + stamp;
  return 'lead-report' + range;
}

async function _fetchReportLeads() {
  const filters = _currentReportFilters();
  let resp;
  try {
    resp = await api('api_reports_exportLeads', filters);
  } catch (e) {
    alert('Could not load leads for export: ' + (e.message || e));
    return null;
  }
  if (!resp || !Array.isArray(resp.leads) || resp.leads.length === 0) {
    alert('No leads match the current report filters — nothing to export.');
    return null;
  }
  if (resp.truncated) {
    alert('Export truncated to the first ' + resp.max + ' leads. Narrow the date range or filters to get the full list.');
  }
  return { filters, leads: resp.leads };
}

async function downloadReportExcel() {
  const ctx = await _fetchReportLeads();
  if (!ctx) return;
  let XLSX;
  try {
    XLSX = await ensureXLSX();
  } catch (e) {
    alert('Could not load the Excel library — try the CSV button instead.');
    return;
  }
  const rows = ctx.leads.map(_buildExportRow);
  const ws = XLSX.utils.json_to_sheet(rows);
  // Auto-size columns based on the longest cell — keeps Phone/Email readable
  // without manual fiddling in Excel.
  const colWidths = [];
  if (rows.length) {
    Object.keys(rows[0]).forEach((header, i) => {
      let max = String(header).length;
      rows.forEach(r => {
        const v = r[header] == null ? '' : String(r[header]);
        if (v.length > max) max = v.length;
      });
      colWidths[i] = { wch: Math.min(Math.max(max + 2, 10), 50) };
    });
  }
  ws['!cols'] = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');
  XLSX.writeFile(wb, _exportFilenameStem(ctx.filters) + '.xlsx');
}

async function downloadReportCsv() {
  const ctx = await _fetchReportLeads();
  if (!ctx) return;
  const rows = ctx.leads.map(_buildExportRow);
  // Union of all keys so custom-field columns aren't dropped if the first
  // lead happens to have no extras.
  const headerSet = [];
  rows.forEach(r => Object.keys(r).forEach(k => { if (!headerSet.includes(k)) headerSet.push(k); }));
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headerSet.map(escape).join(',')];
  rows.forEach(r => lines.push(headerSet.map(k => escape(r[k])).join(',')));
  // Lead with a UTF-8 BOM so Excel opens the file with the right encoding
  // (otherwise Indian names with diacritics show up as gibberish).
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = _exportFilenameStem(ctx.filters) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Renders the daily breakdown: a multi-line chart (Total / New / Won / Lost
 * per day) AND a sortable table below so users can read the exact numbers.
 *
 * Most users want to see "how many leads did we get on each day" alongside
 * the rolled-up totals — without this they have to eyeball the chart and
 * miss small differences between days.
 */
function renderDailyBreakdown(daily, filters) {
  const tableEl = $('#rep-daily-table');
  if (!tableEl) return;

  // Empty state
  if (!daily || daily.length === 0) {
    tableEl.innerHTML = '<p class="muted">No leads in the selected range.</p>';
    const ctx = document.getElementById('chart-daily');
    if (ctx && ctx._chart) { ctx._chart.destroy(); ctx._chart = null; }
    return;
  }

  // Multi-line chart: Total + New + Won + Lost per day
  const labels = daily.map(d => formatDayLabel(d.date));
  const ctx = document.getElementById('chart-daily');
  if (ctx) {
    if (ctx._chart) ctx._chart.destroy();
    ctx._chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Total', data: daily.map(d => d.total),     borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,.1)', tension: .25, fill: true },
          { label: 'New',   data: daily.map(d => d.new_leads), borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,.05)', tension: .25 },
          { label: 'Won',   data: daily.map(d => d.won),       borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.05)', tension: .25 },
          { label: 'Lost',  data: daily.map(d => d.lost),      borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,.05)',  tension: .25 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top' },
          // Multi-line chart with 4 datasets → labelling every point would
          // overwhelm. Keep numbers visible via the table below + tooltip.
          datalabels: false
        },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: '#f3f4f6' }, beginAtZero: true, ticks: { stepSize: 1, precision: 0 } }
        },
        interaction: { mode: 'index', intersect: false }
      }
    });
  }

  // Detailed table — one row per day, with totals row at the bottom
  const totals = daily.reduce((a, d) => ({
    total: a.total + d.total,
    new_leads: a.new_leads + d.new_leads,
    open: a.open + d.open,
    won: a.won + d.won,
    lost: a.lost + d.lost
  }), { total: 0, new_leads: 0, open: 0, won: 0, lost: 0 });

  tableEl.innerHTML = '';
  tableEl.appendChild(h('div', { class: 'table-wrap', style: { maxHeight: '420px', overflowY: 'auto' } },
    h('table', { class: 'mini-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Date'), h('th', { style: { textAlign: 'right' } }, 'Total'),
        h('th', { style: { textAlign: 'right' } }, 'New'), h('th', { style: { textAlign: 'right' } }, 'Open'),
        h('th', { style: { textAlign: 'right' } }, 'Won'), h('th', { style: { textAlign: 'right' } }, 'Lost')
      )),
      h('tbody', {}, ...daily.map(d => h('tr', {},
        h('td', {}, formatDayLabel(d.date)),
        h('td', { style: { textAlign: 'right' } }, d.total),
        h('td', { style: { textAlign: 'right' } }, d.new_leads),
        h('td', { style: { textAlign: 'right' } }, d.open),
        h('td', { class: 'cell-ok',  style: { textAlign: 'right' } }, d.won),
        h('td', { class: 'cell-err', style: { textAlign: 'right' } }, d.lost)
      ))),
      h('tfoot', {}, h('tr', { style: { fontWeight: 700, background: '#f9fafb' } },
        h('td', {}, 'Total'),
        h('td', { style: { textAlign: 'right' } }, totals.total),
        h('td', { style: { textAlign: 'right' } }, totals.new_leads),
        h('td', { style: { textAlign: 'right' } }, totals.open),
        h('td', { style: { textAlign: 'right' } }, totals.won),
        h('td', { style: { textAlign: 'right' } }, totals.lost)
      ))
    )
  ));

  // CSV download — quick win for users who want to paste into Excel/Sheets
  const csvBtn = $('#rep-daily-csv');
  if (csvBtn) {
    csvBtn.onclick = () => {
      const lines = ['Date,Total,New,Open,Won,Lost'];
      daily.forEach(d => lines.push([d.date, d.total, d.new_leads, d.open, d.won, d.lost].join(',')));
      lines.push(['Total', totals.total, totals.new_leads, totals.open, totals.won, totals.lost].join(','));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'daily-report-' + (filters.from || daily[0].date) + '_to_' + (filters.to || daily[daily.length - 1].date) + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  }
}

function formatDayLabel(iso) {
  // Compact format matching the existing date pattern in remarks/dates.
  // "2026-04-25" → "25 Apr"
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

/**
 * Render a CSS-based lead funnel into the given container.
 *
 * Each stage is a colored, rounded "bar" whose width is proportional to the
 * count, centered on the page (so it visually narrows like a real funnel).
 * Shows: stage label · absolute count · % of the top stage (conversion rate).
 *
 * Replaces the old horizontal Chart.js bar — which was indistinguishable from
 * a regular bar chart — with a more traditional funnel design that makes
 * stage-to-stage drop-off obvious at a glance.
 */
function renderFunnel(containerId, stages) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!stages || !stages.length) {
    wrap.innerHTML = '<p class="muted">No funnel data for this period.</p>';
    return;
  }
  // Waterfall ordering — sort by count DESC so the biggest stage is on top
  // and each subsequent row is narrower. Hide stages with zero leads —
  // they're noise in a funnel view (no row to show).
  const sorted = [...stages]
    .map(s => ({ ...s, _c: Number(s.count) || 0 }))
    .filter(s => s._c > 0)
    .sort((a, b) => b._c - a._c);
  if (!sorted.length) {
    wrap.innerHTML = '<p class="muted">No leads in any stage for this period.</p>';
    return;
  }
  const top = sorted[0]._c;
  sorted.forEach((s, i) => {
    const c = s._c;
    // Width is proportional to the top (biggest) stage so the visual
    // narrows as you go down. Min 8% so 1-lead stages still show a tag.
    const widthPct = top > 0 ? Math.max(8, Math.round((c / top) * 100)) : 8;
    const convPct  = top > 0 ? Math.round((c / top) * 100) : 0;
    const row = h('div', { class: 'rfun-row' },
      h('div', { class: 'rfun-track' },
        h('div', { class: 'rfun-bar', style: { width: widthPct + '%', background: s.color || '#6366f1' } },
          h('span', { class: 'rfun-label' }, s.name),
          h('span', { class: 'rfun-count' }, String(c))
        )
      ),
      h('div', { class: 'rfun-meta muted' }, i === 0 ? '100%' : (convPct + '% of top'))
    );
    wrap.appendChild(row);
  });
}

function makeChart(canvasId, type, labels, data, colors, extra) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (ctx._chart) ctx._chart.destroy();
  const palette = colors && colors.some(Boolean) ? colors : ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'];

  const isHorizontalBar = (extra && extra.indexAxis === 'y');
  const isPieish = type === 'doughnut' || type === 'pie';

  // Datalabel config — render the numeric value on each bar/segment so the
  // user can read the actual numbers, not just the relative bar height.
  // We only attach datalabels if the plugin is loaded (it's loaded in
  // ensureChartJs but kept best-effort).
  const datalabels = window.ChartDataLabels ? {
    color: isPieish ? '#ffffff' : '#1B233A',
    font: { weight: 'bold', size: 11 },
    formatter: (value) => {
      if (value === 0 || value === null || value === undefined) return '';
      return value;
    },
    anchor: isPieish ? 'center' : (isHorizontalBar ? 'end' : 'end'),
    align:  isPieish ? 'center' : (isHorizontalBar ? 'right' : 'top'),
    offset: 2,
    clamp: true
  } : false;

  const baseOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: isPieish ? 'bottom' : 'top' },
      datalabels
    },
    scales: isPieish ? {} : { x: { grid: { display: false } }, y: { grid: { color: '#f3f4f6' }, beginAtZero: true } }
  };

  // Merge extra options without clobbering our plugins.datalabels block:
  // Object.assign with a top-level `extra` whose `plugins` would replace ours.
  const merged = Object.assign({}, baseOpts, extra || {});
  if (extra && extra.plugins) {
    merged.plugins = Object.assign({}, baseOpts.plugins, extra.plugins);
  }
  if (extra && extra.scales) {
    merged.scales = Object.assign({}, baseOpts.scales, extra.scales);
  }

  ctx._chart = new Chart(ctx, {
    type, data: {
      labels, datasets: [{
        data,
        backgroundColor: labels.map((_, i) => palette[i % palette.length]),
        borderWidth: 0,
        // For line charts (e.g. daily breakdown) Chart.js wants these too:
        borderColor: palette[0],
        pointBackgroundColor: palette[0],
        tension: 0.25
      }]
    },
    options: merged
  });
}

/* ---------------- Report Builder ----------------------------------
 * Pivot-style report — pick ANY field (built-in or custom) as the
 * "group by" dimension and instantly see the breakdown as a bar chart
 * + table, with drill-in to the underlying leads. Same filter set as
 * the regular Reports tab so the two views stay numerically consistent.
 * ------------------------------------------------------------------ */
VIEWS.reportbuilder = async (view) => {
  await ensureChartJs();
  view.innerHTML = '';
  const { users = [], products = [], sources = [], statuses = [], customFields = [] } = CRM.cache;

  // Built-in dimensions every CRM has — grouped so the dropdown reads naturally.
  const builtIn = [
    { value: 'product',       label: 'Product' },
    { value: 'status',        label: 'Status' },
    { value: 'source',        label: 'Source' },
    { value: 'assigned_to',   label: 'Assigned user' },
    { value: 'qualified',     label: 'Qualified flag' },
    { value: 'is_duplicate',  label: 'Duplicate flag' },
    { value: 'tags',          label: 'Tag (multi-value)' },
    { value: 'city',          label: 'City' },
    { value: 'state',         label: 'State' },
    { value: 'country',       label: 'Country' },
    { value: 'company',       label: 'Company' },
    { value: 'utm_source',    label: 'UTM Source' },
    { value: 'utm_medium',    label: 'UTM Medium' },
    { value: 'utm_campaign',  label: 'UTM Campaign' },
    { value: 'utm_term',      label: 'UTM Term' },
    { value: 'utm_content',   label: 'UTM Content' },
    { value: 'gclid',         label: 'GCLID' },
    { value: 'gad_campaignid',label: 'Google Ads Campaign ID' },
    { value: 'created_day',   label: 'Created date (day)' },
    { value: 'created_month', label: 'Created date (month)' }
  ];
  const customDims = (customFields || []).map(cf => ({
    value: 'extra:' + cf.key,
    label: 'Custom · ' + cf.label
  }));

  // Build a grouped <select> so users see "Built-in" vs "Custom fields"
  // sections rather than one giant flat list — much easier to scan.
  const dimSelect = h('select', { id: 'rb-dim', style: { minWidth: '220px' } });
  const builtInGroup = document.createElement('optgroup');
  builtInGroup.label = 'Built-in';
  builtIn.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    builtInGroup.appendChild(opt);
  });
  dimSelect.appendChild(builtInGroup);
  if (customDims.length) {
    const customGroup = document.createElement('optgroup');
    customGroup.label = 'Custom fields';
    customDims.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      customGroup.appendChild(opt);
    });
    dimSelect.appendChild(customGroup);
  }

  view.append(
    h('div', { class: 'card', style: { padding: '1rem', marginBottom: '1rem' } },
      h('h3', { style: { marginTop: 0 } }, '🧪 Report builder'),
      h('p', { class: 'muted', style: { marginBottom: '.75rem' } },
        'Pick any field below — including any custom field on your leads — and ' +
        'see how leads break down by that field. Apply date and other filters ' +
        'on the right. Click any row in the table to view the leads in that bucket.'),
      h('div', { class: 'toolbar', style: { flexWrap: 'wrap' } },
        h('span', { class: 'muted' }, 'Group by'),
        dimSelect,
        h('span', { class: 'muted', style: { marginLeft: '1rem' } }, 'From'),
        h('input', { type: 'date', id: 'rb-from' }),
        h('span', { class: 'muted' }, 'to'),
        h('input', { type: 'date', id: 'rb-to' }),
        selectOpts('rb-user', [{ id: '', name: 'All users' }, ...users]),
        h('select', { id: 'rb-status' },
          h('option', { value: '' }, 'Any status'),
          ...statuses.map(s => h('option', { value: s.id }, s.name))
        ),
        h('select', { id: 'rb-product' },
          h('option', { value: '' }, 'Any product'),
          ...products.map(p => h('option', { value: p.id }, p.name))
        ),
        selectOpts('rb-source', [{ id: '', name: 'Any source' }, ...sources.map(s => ({ id: s.name, name: s.name }))]),
        h('select', { id: 'rb-qualified' },
          h('option', { value: '' }, 'Any qualified'),
          h('option', { value: '1' }, 'Qualified only'),
          h('option', { value: '0' }, 'Not qualified')
        ),
        h('button', { class: 'btn primary', onclick: loadReportBuilder }, '🔎 Generate'),
        h('button', { class: 'btn', onclick: downloadReportBuilderExcel, title: 'Export breakdown + lead details to Excel' }, '📊 Export Excel'),
        h('button', { class: 'btn', onclick: downloadReportBuilderCsv, title: 'Export breakdown to CSV' }, '⬇️ CSV')
      )
    ),
    h('div', { id: 'rb-summary', class: 'cards', style: { marginBottom: '1rem' } }),
    h('div', { class: 'chart-grid' },
      h('div', { class: 'card card-wide' },
        h('h3', { id: 'rb-chart-title' }, 'Breakdown'),
        h('div', { class: 'chart-wrap', style: { height: '320px' } }, h('canvas', { id: 'rb-chart' }))
      ),
      h('div', { class: 'card card-wide' },
        h('h3', {}, 'Detail'),
        h('div', { id: 'rb-table' })
      )
    )
  );

  // Persist last-chosen dimension so coming back to the tab is fast.
  const last = localStorage.getItem('rb_last_dim');
  if (last && [...dimSelect.options].some(o => o.value === last)) dimSelect.value = last;

  await loadReportBuilder();
};

function _currentReportBuilderFilters() {
  return {
    from:        $('#rb-from')?.value || undefined,
    to:          $('#rb-to')?.value   || undefined,
    scope_user_id: $('#rb-user')?.value   || undefined,
    status_id:   $('#rb-status')?.value   || undefined,
    product_id:  $('#rb-product')?.value  || undefined,
    source:      $('#rb-source')?.value   || undefined,
    qualified:   $('#rb-qualified')?.value || undefined
  };
}

async function loadReportBuilder() {
  const dim = $('#rb-dim')?.value || 'product';
  localStorage.setItem('rb_last_dim', dim);
  const filters = _currentReportBuilderFilters();
  let resp;
  try {
    resp = await api('api_reports_groupBy', filters, dim);
  } catch (e) {
    $('#rb-table').innerHTML = `<div class="error-box">${esc(e.message || e)}</div>`;
    return;
  }
  const dimLabel = $('#rb-dim')?.options[$('#rb-dim').selectedIndex]?.text || dim;
  const titleEl = $('#rb-chart-title');
  if (titleEl) titleEl.textContent = 'Leads by ' + dimLabel;

  // Top stat cards — buckets, total, top bucket
  const summaryEl = $('#rb-summary');
  if (summaryEl) {
    summaryEl.innerHTML = '';
    const top = resp.rows[0];
    [
      ['Total leads', resp.total, 'accent'],
      ['Distinct values', resp.rows.length, ''],
      ['Top bucket', top ? `${top.value} (${top.count})` : '—', 'ok']
    ].forEach(([label, val, klass]) => {
      summaryEl.appendChild(h('div', { class: `card stat ${klass}` },
        h('div', { class: 'stat-body' },
          h('div', { class: 'stat-label' }, label),
          h('div', { class: 'stat-value', style: { fontSize: '1.2rem' } }, String(val))
        )
      ));
    });
  }

  // Chart — top 25 buckets so a high-cardinality dimension (e.g. UTM Term)
  // doesn't render an unreadable forest of bars.
  const top25 = resp.rows.slice(0, 25);
  const ctx = document.getElementById('rb-chart');
  if (ctx) {
    if (ctx._chart) ctx._chart.destroy();
    const palette = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
    ctx._chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: top25.map(r => r.value),
        datasets: [{
          label: 'Leads',
          data: top25.map(r => r.count),
          backgroundColor: top25.map((_, i) => palette[i % palette.length]),
          borderWidth: 0
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, datalabels: { color: '#111', anchor: 'end', align: 'right', font: { weight: 'bold' } } },
        scales: { x: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } }
      }
    });
  }

  // Detail table — every bucket, with click-to-drill into the leads view
  const tableEl = $('#rb-table');
  tableEl.innerHTML = '';
  if (!resp.rows.length) {
    tableEl.innerHTML = '<p class="muted">No leads match these filters.</p>';
    return;
  }
  const totalCount = resp.rows.reduce((a, r) => a + r.count, 0);
  tableEl.appendChild(h('div', { class: 'table-wrap', style: { maxHeight: '480px', overflowY: 'auto' } },
    h('table', { class: 'mini-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, dimLabel),
        h('th', { style: { textAlign: 'right' } }, 'Leads'),
        h('th', { style: { textAlign: 'right' } }, '% of total'),
        h('th', { style: { textAlign: 'right' } }, '')
      )),
      h('tbody', {}, ...resp.rows.map(r => h('tr', {},
        h('td', {}, r.value),
        h('td', { style: { textAlign: 'right', fontWeight: 600 } }, r.count),
        h('td', { style: { textAlign: 'right' } }, totalCount > 0 ? ((r.count / totalCount) * 100).toFixed(1) + '%' : '0%'),
        h('td', { style: { textAlign: 'right' } },
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); _drillReportBuilder(r.lead_ids); } }, 'View leads →')
        )
      ))),
      h('tfoot', {}, h('tr', { style: { fontWeight: 700, background: '#f9fafb' } },
        h('td', {}, 'Total'),
        h('td', { style: { textAlign: 'right' } }, totalCount),
        h('td', { style: { textAlign: 'right' } }, '100%'),
        h('td', {}, '')
      ))
    )
  ));
}

/**
 * Open a modal listing the leads in a bucket. Lighter than navigating the
 * leads page — keeps the report context on screen for follow-up clicks.
 */
async function _drillReportBuilder(leadIds) {
  if (!leadIds || !leadIds.length) return;
  // Reuse the leads view by stashing the id set in a query and navigating.
  // The simplest UX: open each lead in turn would be too noisy. Instead we
  // open a quick popup listing names + a link to each.
  let leads = [];
  try {
    // Pull just the matching leads — cap to 200 to keep the popup snappy.
    const ids = leadIds.slice(0, 200);
    const r = await api('api_leads_list', { page_size: 500 });
    leads = (r.leads || []).filter(l => ids.includes(Number(l.id)));
  } catch (e) {
    alert('Could not load leads: ' + (e.message || e));
    return;
  }
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, 'Leads in this bucket'),
        h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
      ),
      h('div', { class: 'modal-body' },
        h('p', { class: 'muted' }, leadIds.length + ' lead' + (leadIds.length === 1 ? '' : 's') + ' in this bucket' +
          (leadIds.length > 200 ? ' (showing first 200)' : '')),
        h('div', { class: 'table-wrap', style: { maxHeight: '50vh', overflowY: 'auto' } },
          h('table', { class: 'mini-table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Phone'), h('th', {}, 'Status'), h('th', {}, 'Owner'), h('th', {}, ''))),
            h('tbody', {}, ...leads.map(l => h('tr', {},
              h('td', {}, l.name || '—'),
              h('td', {}, l.phone || ''),
              h('td', {}, l.status_name || ''),
              h('td', {}, l.assigned_name || ''),
              h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); m.remove(); openLeadModal(l.id); } }, 'Open →'))
            )))
          )
        )
      )
    )
  );
  document.body.appendChild(m);
}

async function downloadReportBuilderCsv() {
  const dim = $('#rb-dim')?.value || 'product';
  const filters = _currentReportBuilderFilters();
  let resp;
  try { resp = await api('api_reports_groupBy', filters, dim); }
  catch (e) { alert('Could not load: ' + (e.message || e)); return; }
  if (!resp.rows.length) { alert('No data to export.'); return; }

  const dimLabel = $('#rb-dim')?.options[$('#rb-dim').selectedIndex]?.text || dim;
  const total = resp.rows.reduce((a, r) => a + r.count, 0);
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [[dimLabel, 'Leads', '% of total'].map(escape).join(',')];
  resp.rows.forEach(r => {
    const pct = total > 0 ? ((r.count / total) * 100).toFixed(2) + '%' : '0%';
    lines.push([r.value, r.count, pct].map(escape).join(','));
  });
  lines.push(['Total', total, '100%'].map(escape).join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = 'report-by-' + dim.replace(/[^a-z0-9]+/gi, '-') + '_' + stamp + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadReportBuilderExcel() {
  const dim = $('#rb-dim')?.value || 'product';
  const filters = _currentReportBuilderFilters();
  let resp, leadsResp;
  try {
    [resp, leadsResp] = await Promise.all([
      api('api_reports_groupBy', filters, dim),
      api('api_reports_exportLeads', filters)
    ]);
  } catch (e) { alert('Could not load: ' + (e.message || e)); return; }
  if (!resp.rows.length) { alert('No data to export.'); return; }

  let XLSX;
  try { XLSX = await ensureXLSX(); }
  catch (_) { return downloadReportBuilderCsv(); }

  const dimLabel = $('#rb-dim')?.options[$('#rb-dim').selectedIndex]?.text || dim;
  const total = resp.rows.reduce((a, r) => a + r.count, 0);

  // Sheet 1: the breakdown
  const breakdown = resp.rows.map(r => ({
    [dimLabel]: r.value,
    'Leads': r.count,
    '% of total': total > 0 ? ((r.count / total) * 100).toFixed(2) + '%' : '0%'
  }));
  breakdown.push({ [dimLabel]: 'Total', 'Leads': total, '% of total': '100%' });

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(breakdown);
  ws1['!cols'] = [{ wch: 32 }, { wch: 10 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Breakdown');

  // Sheet 2: the underlying leads (with the same column shape as the regular
  // report Excel export, so users get one file with both views).
  if (leadsResp && leadsResp.leads && leadsResp.leads.length) {
    const rows = leadsResp.leads.map(_buildExportRow);
    const ws2 = XLSX.utils.json_to_sheet(rows);
    if (rows.length) {
      const cols = [];
      Object.keys(rows[0]).forEach((header, i) => {
        let max = String(header).length;
        rows.forEach(r => {
          const v = r[header] == null ? '' : String(r[header]);
          if (v.length > max) max = v.length;
        });
        cols[i] = { wch: Math.min(Math.max(max + 2, 10), 50) };
      });
      ws2['!cols'] = cols;
    }
    XLSX.utils.book_append_sheet(wb, ws2, 'Leads');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, 'report-by-' + dim.replace(/[^a-z0-9]+/gi, '-') + '_' + stamp + '.xlsx');
}

/* ---------------- Admin ---------------- */
VIEWS.admin = async (view) => {
  view.innerHTML = '';
  const tabs = [
    { id: 'company',      label: 'Company' },
    { id: 'api',          label: 'Website API' },
    { id: 'automations',  label: 'Automations' },
    { id: 'fb',           label: 'Facebook' },
    { id: 'whatsapp',     label: 'WhatsApp' },
    { id: 'sources',      label: 'Sources' },
    { id: 'statuses',     label: 'Statuses' },
    { id: 'customfields', label: 'Custom Fields' },
    { id: 'tags',         label: 'Tags' },
    { id: 'tat',          label: '⏱️ TAT' },
    { id: 'rules',        label: 'Auto-assign Rules' },
    { id: 'permissions',  label: '🔐 Permissions' },
    { id: 'duplicates',   label: 'Duplicates' },
    { id: 'smtp',         label: 'SMTP' },
    { id: 'announce',     label: '📢 Announcements' },
    { id: 'chatperm',     label: '💬 Chat permissions' },
    { id: 'menu',         label: '🧭 Menu visibility' },
    { id: 'projstages',   label: '🚚 Project stages' },
    { id: 'integrations', label: '🔌 Integrations' },
    { id: 'dangerzone',   label: '🛑 Danger zone' }
  ];
  const nav = h('div', { class: 'subtabs' },
    ...tabs.map(t => h('button', { class: 'subtab', 'data-tab': t.id, onclick: () => showAdminTab(t.id) }, t.label))
  );
  view.appendChild(nav);
  view.appendChild(h('div', { id: 'admin-body' }));
  showAdminTab('company');
};

async function showAdminTab(id) {
  $$('.subtab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  const body = $('#admin-body');
  body.innerHTML = '<div class="loading">Loading…</div>';
  try {
    if (id === 'company')     body.replaceChildren(await adminCompany());
    if (id === 'api')         body.replaceChildren(await adminApi());
    if (id === 'automations') body.replaceChildren(await adminAutomations());
    if (id === 'fb')          body.replaceChildren(await adminFb());
    if (id === 'whatsapp') body.replaceChildren(await adminWhatsapp());
    if (id === 'sources')  body.replaceChildren(await adminSources());
    if (id === 'statuses') body.replaceChildren(await adminStatuses());
    if (id === 'customfields') body.replaceChildren(await adminCustomFields());
    if (id === 'tags')     body.replaceChildren(await adminTags());
    if (id === 'tat')      body.replaceChildren(await adminTat());
    if (id === 'rules')    body.replaceChildren(await adminRules());
    if (id === 'permissions') body.replaceChildren(await adminPermissions());
    if (id === 'duplicates') body.replaceChildren(await adminDuplicates());
    if (id === 'smtp')     body.replaceChildren(await adminSmtp());
    if (id === 'announce') body.replaceChildren(await adminAnnouncements());
    if (id === 'chatperm') body.replaceChildren(await adminChatPermissions());
    if (id === 'menu')     body.replaceChildren(await adminMenuVisibility());
    if (id === 'projstages') body.replaceChildren(await adminProjectStages());
    if (id === 'integrations') body.replaceChildren(await adminIntegrations());
    if (id === 'dangerzone') body.replaceChildren(await adminDangerZone());
  } catch (e) { body.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
}

/**
 * Admin → Danger zone tab. Currently hosts the "Wipe HR data" tool.
 *
 * Lets the admin permanently delete all rows in the Leaves, Tasks,
 * Attendance, and/or Salary tables. Lead/customer/user data is NOT
 * touched. Requires the admin to type "WIPE-NOW" exactly into the
 * confirmation field — anything else is rejected server-side.
 */
async function adminDangerZone() {
  const wrap = h('div', {});
  const card = h('div', { class: 'card', style: { borderLeft: '4px solid #dc2626' } });
  card.appendChild(h('h4', { style: { marginTop: 0, color: '#dc2626' } }, '🛑 Wipe HR data'));
  card.appendChild(h('p', { class: 'muted' },
    'Permanently delete all rows in the selected categories. ',
    h('b', {}, 'This cannot be undone.'),
    ' Lead, customer, and user accounts are not touched — only HR-side data.'
  ));

  const cats = [
    { key: 'leaves',     label: 'Leaves data',     desc: 'Every applied/approved/rejected leave record' },
    { key: 'tasks',      label: 'Tasks data',      desc: 'All tasks created in the Tasks module' },
    { key: 'attendance', label: 'Attendance data', desc: 'Daily check-in/check-out logs + the linked location pings' },
    { key: 'salary',     label: 'Salary data',     desc: 'Monthly salary records (the user.monthly_salary base figure on each user is preserved)' }
  ];
  const checks = {};
  cats.forEach(c => {
    checks[c.key] = h('input', { type: 'checkbox', value: c.key });
    card.appendChild(h('label', { style: { display: 'flex', gap: '.5rem', alignItems: 'flex-start', padding: '.4rem 0' } },
      checks[c.key],
      h('span', {},
        h('b', {}, c.label),
        h('div', { class: 'muted', style: { fontSize: '.78rem' } }, c.desc)
      )
    ));
  });

  const confirmInput = h('input', { type: 'text', placeholder: 'Type WIPE-NOW to confirm', autocomplete: 'off',
    style: { fontFamily: 'monospace', letterSpacing: '.05em' } });
  card.appendChild(h('div', { class: 'f-row full', style: { marginTop: '1rem' } },
    h('label', {}, 'Confirmation phrase'),
    confirmInput
  ));
  card.appendChild(h('div', { class: 'actions', style: { marginTop: '.5rem' } },
    h('button', { class: 'btn danger', onclick: async () => {
      const picked = cats.filter(c => checks[c.key].checked).map(c => c.key);
      if (!picked.length) { toast('Pick at least one category to wipe', 'err'); return; }
      const phrase = confirmInput.value;
      if (phrase !== 'WIPE-NOW') {
        toast('Type WIPE-NOW exactly to confirm — case + dash matter', 'err');
        confirmInput.focus();
        return;
      }
      if (!await confirmDialog(`Permanently delete: ${picked.join(', ')}? This cannot be undone.`)) return;
      try {
        const r = await api('api_admin_wipeHrData', picked, phrase);
        const msg = Object.entries(r.deleted || {})
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ');
        toast('Wiped — ' + (msg || 'done'));
        confirmInput.value = '';
        cats.forEach(c => { checks[c.key].checked = false; });
      } catch (e) { toast(e.message, 'err'); }
    } }, '🗑️ Wipe selected data')
  ));

  wrap.appendChild(card);
  return wrap;
}

/**
 * Admin → Integrations tab. Two sections:
 *  1. Lead-source webhooks — copy-paste URL per vendor (IndiaMART,
 *     MagicBricks, JustDial, TradeIndia, 99acres, Housing).
 *  2. Google Sheet sync — manage connected sheets.
 */
async function adminIntegrations() {
  const cfg = await api('api_admin_getConfig').catch(() => ({}));
  const apiKey = cfg.WEBSITE_API_KEY || '';
  const base = location.origin;
  const wrap = h('div', {});

  // --- Section 1: Lead-source webhooks ---
  wrap.appendChild(h('h4', { style: { margin: '0 0 .5rem' } }, '🌐 Lead-source webhooks'));
  if (!apiKey) {
    wrap.appendChild(h('p', { class: 'error-box' },
      'No API key set yet. Generate one in the API tab first; webhook URLs need it.'));
  } else {
    wrap.appendChild(h('p', { class: 'muted' },
      'Paste these URLs into each vendor\'s lead-notification settings. The CRM auto-maps their field names to lead columns.'));
    const sources = [
      { id: 'indiamart',   label: 'IndiaMART',     guide: 'IndiaMART Seller dashboard → Lead Manager → CRM Integration → paste URL' },
      { id: 'magicbricks', label: 'MagicBricks',   guide: 'MagicBricks Builder/Agent dashboard → Lead Settings → API/Webhook → paste URL' },
      { id: 'justdial',    label: 'JustDial',      guide: 'JustDial business dashboard → Lead Push API → Webhook URL → paste URL' },
      { id: 'tradeindia',  label: 'TradeIndia',    guide: 'TradeIndia Seller panel → Lead Manager → External CRM → paste URL' },
      { id: '99acres',     label: '99acres',       guide: '99acres dashboard → Lead Settings → Webhook → paste URL' },
      { id: 'housing',     label: 'Housing.com',   guide: 'Housing.com builder/agent dashboard → Integrations → paste URL' },
      { id: 'generic',     label: 'Custom / generic', guide: 'For any other source — vendor sends JSON with name/phone/email keys' }
    ];
    const list = h('div', { class: 'card', style: { padding: '0' } });
    sources.forEach((s, idx) => {
      const url = base + '/hook/leadsource/' + s.id + '/' + apiKey;
      list.appendChild(h('div', {
        style: { padding: '.75rem .9rem', borderTop: idx === 0 ? 'none' : '1px solid #f3f4f6', display: 'flex', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' }
      },
        h('div', { style: { flex: '1 1 200px' } },
          h('div', { style: { fontWeight: 600 } }, s.label),
          h('div', { class: 'muted', style: { fontSize: '.78rem' } }, s.guide)
        ),
        h('input', {
          type: 'text', readonly: 'readonly', value: url,
          style: { flex: '1 1 320px', fontFamily: 'monospace', fontSize: '.78rem' }
        }),
        h('button', { class: 'btn sm', onclick: ev => {
          const inp = ev.target.parentNode.querySelector('input');
          navigator.clipboard.writeText(inp.value).then(() => toast('Copied'), () => { inp.select(); document.execCommand('copy'); toast('Copied'); });
        } }, '📋 Copy')
      ));
    });
    wrap.appendChild(list);
  }

  // --- Section 2: Google Sheet sync ---
  wrap.appendChild(h('h4', { style: { margin: '1.5rem 0 .5rem' } }, '📊 Google Sheet sync'));
  wrap.appendChild(h('p', { class: 'muted' },
    'Connect a Google Sheet — set its share to "Anyone with link → Viewer" — and the CRM polls new rows as leads. Headers should match lead columns (name, phone, email, source, city, notes, etc.).'));
  let sheets = [];
  try { sheets = await api('api_sheetSync_list'); } catch (_) {}
  const sheetList = h('div', { class: 'card', style: { padding: '0' } });
  if (!sheets.length) {
    sheetList.appendChild(h('p', { class: 'muted', style: { padding: '1rem', margin: 0 } }, 'No sheets connected yet.'));
  }
  sheets.forEach((s, idx) => {
    const lastSync = s.last_synced_at ? fmtDate(s.last_synced_at, 'relative') : 'never';
    sheetList.appendChild(h('div', {
      style: { padding: '.75rem .9rem', borderTop: idx === 0 ? 'none' : '1px solid #f3f4f6', display: 'flex', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' }
    },
      h('div', { style: { flex: '1 1 200px' } },
        h('div', { style: { fontWeight: 600 } }, s.name,
          Number(s.is_active) === 0 ? h('span', { class: 'tag', style: { background: '#fef2f2', color: '#991b1b', marginLeft: '.5rem' } }, 'PAUSED') : null),
        h('div', { class: 'muted', style: { fontSize: '.78rem' } },
          'Sheet ' + String(s.sheet_id).slice(0, 12) + '… · every ' + s.poll_interval_min + 'min · last synced ' + lastSync +
          (s.last_synced_count ? ' (' + s.last_synced_count + ' new)' : '')),
        s.last_error ? h('div', { class: 'muted', style: { fontSize: '.78rem', color: '#dc2626' } }, '⚠ ' + s.last_error) : null
      ),
      h('button', { class: 'btn sm', onclick: async () => {
        try { const r = await api('api_sheetSync_runNow', s.id); toast('Synced — ' + r.imported + ' new, ' + r.skipped + ' skipped'); showAdminTab('integrations'); }
        catch (e) { toast(e.message, 'err'); }
      } }, '🔄 Sync now'),
      h('button', { class: 'btn sm', onclick: () => openSheetSyncEditModal(s, () => showAdminTab('integrations')) }, '✎ Edit'),
      h('button', { class: 'btn sm danger', onclick: async () => {
        if (!await confirmDialog('Disconnect "' + s.name + '"? Leads already imported from it stay; the CRM just stops polling.')) return;
        try { await api('api_sheetSync_delete', s.id); toast('Disconnected'); showAdminTab('integrations'); }
        catch (e) { toast(e.message, 'err'); }
      } }, '🗑')
    ));
  });
  wrap.appendChild(sheetList);
  wrap.appendChild(h('div', { class: 'actions', style: { marginTop: '.75rem' } },
    h('button', { class: 'btn primary', onclick: () => openSheetSyncEditModal(null, () => showAdminTab('integrations')) }, '+ Connect Google Sheet')
  ));

  // --- Section 3: Gmail Apps Script (no native OAuth — show wizard) ---
  wrap.appendChild(h('h4', { style: { margin: '1.5rem 0 .5rem' } }, '✉ Gmail → CRM (via Apps Script)'));
  wrap.appendChild(h('p', { class: 'muted' },
    'For sources that send leads via email (IndiaMART/MagicBricks email notifications, contact-form replies). Free, runs in your Google account, takes ~3 min to set up.'));
  if (apiKey) {
    const script = `// Set up:
// 1) In Gmail, create a label "ToCRM" and a filter that auto-applies it
//    to lead emails (e.g. from:noreply@indiamart.com).
// 2) Open script.google.com → New project → paste this code → Save.
// 3) Triggers (clock icon) → Add → importGmailLeads → time-driven → 5 min.
const CRM_URL = '${base}';
const API_KEY = '${apiKey}';
const LABEL = 'ToCRM';
const PROCESSED = 'CRM-Sent';

function importGmailLeads() {
  const label = GmailApp.getUserLabelByName(LABEL);
  const done = GmailApp.getUserLabelByName(PROCESSED) || GmailApp.createLabel(PROCESSED);
  if (!label) { Logger.log('No "ToCRM" label found'); return; }
  label.getThreads(0, 50).forEach(t => {
    if (t.getLabels().some(l => l.getName() === PROCESSED)) return;
    const m = t.getMessages()[0];
    const body = m.getPlainBody();
    const lead = {
      name:  (body.match(/Name[:\\s]+(.+)/i) || [, ''])[1].trim(),
      phone: (body.match(/(?:Phone|Mobile)[:\\s]+([+\\d\\s-]+)/i) || [, ''])[1].trim(),
      email: (body.match(/Email[:\\s]+([^\\s]+@[^\\s]+)/i) || [, m.getFrom()])[1],
      city:  (body.match(/City[:\\s]+(.+)/i) || [, ''])[1].trim(),
      notes: 'Email subject: ' + m.getSubject(),
      source: 'Email'
    };
    if (!lead.name || !lead.phone) return;
    const res = UrlFetchApp.fetch(CRM_URL + '/hook/website', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': API_KEY }, payload: JSON.stringify(lead),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) t.addLabel(done);
  });
}`;
    const ta = h('textarea', { readonly: 'readonly', rows: 12, style: { width: '100%', fontFamily: 'monospace', fontSize: '.75rem' } }, script);
    wrap.appendChild(ta);
    wrap.appendChild(h('button', { class: 'btn sm', onclick: () => {
      ta.select(); navigator.clipboard.writeText(script).then(() => toast('Copied'), () => { document.execCommand('copy'); toast('Copied'); });
    } }, '📋 Copy script'));
  }

  return wrap;
}

function openSheetSyncEditModal(s, onSaved) {
  s = s || { name: '', sheet_url: '', poll_interval_min: 15, default_source: 'Google Sheet', is_active: 1 };
  const sheetUrlValue = s.sheet_id ? `https://docs.google.com/spreadsheets/d/${s.sheet_id}/edit#gid=${s.sheet_gid || '0'}` : '';
  const users = (CRM.cache.users || []).filter(u => Number(u.is_active) === 1);
  const pushUrl = s.webhook_token ? location.origin + '/hook/sheet/' + s.webhook_token : '';
  const pushScript = pushUrl ? `// Paste this into your sheet: Extensions → Apps Script → replace the
// default code with this → Save → Triggers (clock icon) → Add Trigger:
//   Function = pushNewRowsToCRM, Event = Time-driven, every 5 min.
// Add a column called "CRM_Sent" — the script writes ✓ there once a
// row has been sent so it never sends the same row twice.
//
// SHEET STAYS FULLY PRIVATE — the script runs as you (the sheet owner)
// and POSTs each new row to the unique URL below. No "Anyone with link"
// sharing required.
const CRM_WEBHOOK = '${pushUrl}';

function pushNewRowsToCRM() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;
  let headers = data[0].map(h => String(h).trim().toLowerCase());
  let sentCol = headers.indexOf('crm_sent');
  if (sentCol < 0) {
    sheet.getRange(1, headers.length + 1).setValue('CRM_Sent');
    sentCol = headers.length;
    headers.push('crm_sent');
  }
  for (let r = 1; r < data.length; r++) {
    if (data[r][sentCol]) continue;
    const lead = {};
    headers.forEach((h, c) => { if (h && h !== 'crm_sent') lead[h] = data[r][c]; });
    if (!lead.name && !lead.phone) continue;
    try {
      const res = UrlFetchApp.fetch(CRM_WEBHOOK, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(lead), muteHttpExceptions: true
      });
      const ok = res.getResponseCode() === 200;
      sheet.getRange(r + 1, sentCol + 1)
        .setValue(ok ? '✓ ' + new Date().toLocaleString() : '✗ ' + res.getResponseCode());
    } catch (e) {
      sheet.getRange(r + 1, sentCol + 1).setValue('✗ ' + e.message);
    }
  }
}` : '';
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } });
  modal.appendChild(h('div', { class: 'modal modal-lg' },
    h('div', { class: 'modal-head' },
      h('h3', {}, s.id ? 'Edit sheet integration' : '+ Connect Google Sheet'),
      h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
    ),
    h('form', { id: 'ss-form', class: 'form-grid' },
      h('div', { class: 'f-row full' },
        h('label', {}, 'Friendly name *'),
        h('input', { name: 'name', value: s.name, required: 'required', placeholder: 'e.g. IndiaMART weekly leads' })
      ),
      h('div', { class: 'f-row' },
        h('label', {}, 'Default source label'),
        h('input', { name: 'default_source', value: s.default_source || 'Google Sheet' })
      ),
      h('div', { class: 'f-row' },
        h('label', {}, 'Default assignee'),
        h('select', { name: 'default_assignee_id' },
          h('option', { value: '' }, '— Use assignment rules —'),
          ...users.map(u => h('option', { value: u.id, selected: Number(u.id) === Number(s.default_assignee_id) ? 'selected' : null }, u.name))
        )
      ),
      h('div', { class: 'f-row full' },
        h('label', { class: 'qual-toggle' },
          h('input', { name: 'is_active', type: 'checkbox', checked: Number(s.is_active) !== 0 ? 'checked' : null }),
          h('span', {}, ' Active')
        )
      )
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const f = $('#ss-form');
        const fd = new FormData(f);
        const payload = {
          id: s.id,
          name: fd.get('name'),
          // sheet_url is intentionally optional now — push mode (script
          // in private sheet) is the recommended path.
          sheet_url: '',
          poll_interval_min: 15,
          default_source: fd.get('default_source'),
          default_assignee_id: fd.get('default_assignee_id') || null,
          is_active: f.querySelector('[name="is_active"]').checked ? 1 : 0
        };
        if (!payload.name) return toast('Name required', 'err');
        try {
          const r = await api('api_sheetSync_save', payload);
          toast('Saved');
          modal.remove();
          // Re-open the modal in edit mode so the user can see the
          // freshly-generated webhook URL + script
          if (!s.id) {
            const fresh = (await api('api_sheetSync_list')).find(x => Number(x.id) === Number(r.id));
            if (fresh) openSheetSyncEditModal(fresh, onSaved);
            else onSaved && onSaved();
          } else {
            onSaved && onSaved();
          }
        } catch (e) { toast(e.message, 'err'); }
      } }, 'Save')
    ),
    // After save, the integration has a token — show the push setup
    pushUrl ? h('div', { style: { padding: '1rem', borderTop: '1px solid #e5e7eb', background: '#f9fafb' } },
      h('h4', { style: { margin: '0 0 .5rem' } }, '🔒 Recommended: Push from your sheet (sheet stays private)'),
      h('p', { class: 'muted', style: { fontSize: '.82rem' } },
        'Your sheet stays fully private — only you have access. Paste the script below into your sheet, set a 5-minute trigger, done. Each new row gets POSTed to the unique URL below; the CRM accepts it and creates a lead.'),
      h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', marginBottom: '.5rem' } },
        h('strong', { style: { fontSize: '.82rem' } }, 'Webhook URL:'),
        h('input', { type: 'text', readonly: 'readonly', value: pushUrl, style: { flex: 1, fontFamily: 'monospace', fontSize: '.75rem' } }),
        h('button', { class: 'btn sm', onclick: ev => {
          const inp = ev.target.parentNode.querySelector('input');
          navigator.clipboard.writeText(inp.value).then(() => toast('Copied'), () => { inp.select(); document.execCommand('copy'); toast('Copied'); });
        } }, '📋 Copy URL')
      ),
      h('div', { style: { fontWeight: 600, fontSize: '.85rem', marginBottom: '.25rem' } }, 'Apps Script (paste into Sheet → Extensions → Apps Script):'),
      h('textarea', { id: 'sheet-push-script', readonly: 'readonly', rows: 12,
        style: { width: '100%', fontFamily: 'monospace', fontSize: '.72rem' } }, pushScript),
      h('button', { class: 'btn sm', onclick: () => {
        const ta = $('#sheet-push-script');
        ta.select();
        navigator.clipboard.writeText(pushScript).then(() => toast('Script copied'), () => { document.execCommand('copy'); toast('Copied'); });
      } }, '📋 Copy script'),
      h('details', { style: { marginTop: '1rem' } },
        h('summary', { class: 'muted', style: { cursor: 'pointer', fontSize: '.82rem' } }, 'Or use public-CSV polling instead (sheet must be "Anyone with link → Viewer" — less secure)'),
        h('div', { style: { padding: '.75rem 0' } },
          h('p', { class: 'muted', style: { fontSize: '.8rem' } },
            'Less secure but simpler if you don\'t mind a public sheet. The CRM polls the public CSV export every 15 min.'),
          h('div', { style: { display: 'flex', gap: '.5rem' } },
            h('input', { id: 'csv-sheet-url', type: 'text', value: sheetUrlValue,
              placeholder: 'https://docs.google.com/spreadsheets/d/.../edit#gid=0',
              style: { flex: 1 } }),
            h('button', { class: 'btn sm', onclick: async () => {
              const url = $('#csv-sheet-url').value;
              if (!url) return toast('Paste sheet URL first', 'err');
              try { await api('api_sheetSync_save', { id: s.id, name: s.name, sheet_url: url }); toast('Saved — sheet must be "Anyone with link"'); modal.remove(); onSaved && onSaved(); }
              catch (e) { toast(e.message, 'err'); }
            } }, 'Use public CSV mode')
          ),
          // Push-only mode escape hatch — when the admin has set up Apps
          // Script in their (private) sheet, the legacy CSV pull becomes
          // pointless. This button clears sheet_url so the poller skips
          // this integration entirely; the only data path becomes the
          // POST webhook that Apps Script hits.
          sheetUrlValue ? h('div', { class: 'muted', style: { marginTop: '.6rem', fontSize: '.82rem' } },
            'Already using Apps Script push mode (sheet stays private)? ',
            h('a', { href: '#', onclick: async ev => {
              ev.preventDefault();
              if (!await confirmDialog('Switch to push-only mode? The CRM will stop trying to pull from the sheet — only Apps Script POSTs will create leads. Existing webhook URL stays the same.')) return;
              try {
                await api('api_sheetSync_save', { id: s.id, name: s.name, sheet_url: '' });
                toast('Switched to push-only mode — the 404 error will clear on next sync');
                modal.remove();
                onSaved && onSaved();
              } catch (e) { toast(e.message, 'err'); }
            } }, 'Switch to push-only mode (clear sheet URL)')
          ) : null
        )
      )
    ) : null
  ));
  document.body.appendChild(modal);
}

/**
 * Admin → Project stages tab. Lists every stage in sort order with edit /
 * delete actions, plus a "+ New stage" button. Stages are the post-sale
 * delivery workflow (Token → Agreement → Loan → ... → Possession).
 * Reps advance leads through these stages from the lead detail modal.
 */
async function adminProjectStages() {
  const stages = await api('api_projectStages_list');
  const wrap = h('div', {});
  wrap.appendChild(h('h4', { style: { margin: '0 0 .5rem' } }, '🚚 Post-sale project stages'));
  wrap.appendChild(h('p', { class: 'muted' },
    'Define the delivery workflow your team follows after a sale. Reps advance each lead through these stages from the lead detail page; every transition logs a remark on the lead.'));
  const list = h('div', { class: 'card', style: { padding: '.5rem 0' } });
  if (!stages.length) {
    list.appendChild(h('p', { class: 'muted', style: { padding: '1rem' } }, 'No stages yet — click "+ New stage" to create the first.'));
  }
  stages.forEach(s => {
    list.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '.75rem', padding: '.6rem .9rem', borderBottom: '1px solid #f3f4f6' } },
      h('span', { class: 'tag', style: { background: '#e0f2fe', color: '#075985', fontWeight: 600 } }, '#' + s.sort_order),
      h('div', { style: { flex: 1 } },
        h('div', { style: { fontWeight: 600 } }, s.name),
        s.description ? h('div', { class: 'muted', style: { fontSize: '.78rem' } }, s.description) : null
      ),
      h('span', { class: 'muted', style: { fontSize: '.78rem' } }, '⏱ ' + s.expected_days + 'd'),
      s.assignee_role ? h('span', { class: 'tag' }, '👤 ' + s.assignee_role) : null,
      h('button', { class: 'btn sm', onclick: () => openProjectStageEditModal(s, () => showAdminTab('projstages')) }, '✎'),
      h('button', { class: 'btn sm danger', onclick: async () => {
        if (!await confirmDialog('Delete stage "' + s.name + '"? Existing leads on this stage keep their reference but new advances will skip it.')) return;
        try { await api('api_projectStages_delete', s.id); toast('Deleted'); showAdminTab('projstages'); }
        catch (e) { toast(e.message, 'err'); }
      } }, '🗑')
    ));
  });
  wrap.appendChild(list);
  wrap.appendChild(h('div', { class: 'actions', style: { marginTop: '.75rem' } },
    h('button', { class: 'btn primary', onclick: () => openProjectStageEditModal(null, () => showAdminTab('projstages')) }, '+ New stage')
  ));
  return wrap;
}

function openProjectStageEditModal(s, onSaved) {
  s = s || { sort_order: 10, expected_days: 7 };
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } });
  modal.appendChild(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' },
      h('h3', {}, s.id ? 'Edit project stage' : '+ New project stage'),
      h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
    ),
    h('form', { id: 'pst-form', class: 'form-grid' },
      h('div', { class: 'f-row full' },
        h('label', {}, 'Name *'),
        h('input', { name: 'name', value: s.name || '', required: 'required', placeholder: 'e.g. Agreement signed' })
      ),
      h('div', { class: 'f-row full' },
        h('label', {}, 'Description'),
        h('textarea', { name: 'description', rows: 2, placeholder: 'What needs to happen at this stage?' }, s.description || '')
      ),
      h('div', { class: 'f-row' },
        h('label', {}, 'Sort order *'),
        h('input', { name: 'sort_order', type: 'number', min: 1, value: s.sort_order, required: 'required' })
      ),
      h('div', { class: 'f-row' },
        h('label', {}, 'Expected duration (days)'),
        h('input', { name: 'expected_days', type: 'number', min: 1, value: s.expected_days })
      ),
      h('div', { class: 'f-row full' },
        h('label', {}, 'Assigned role'),
        h('select', { name: 'assignee_role' },
          h('option', { value: '' }, '—'),
          ...['sales', 'team_leader', 'manager', 'operations', 'finance', 'legal', 'admin']
            .map(r => h('option', { value: r, selected: s.assignee_role === r ? 'selected' : null }, r))
        )
      )
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const f = $('#pst-form');
        const fd = new FormData(f);
        const payload = {
          id: s.id,
          name:          fd.get('name'),
          description:   fd.get('description'),
          sort_order:    Number(fd.get('sort_order')) || 10,
          expected_days: Number(fd.get('expected_days')) || 7,
          assignee_role: fd.get('assignee_role')
        };
        if (!payload.name) return toast('Name required', 'err');
        try { await api('api_projectStages_save', payload); toast('Saved'); modal.remove(); onSaved && onSaved(); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Save')
    )
  ));
  document.body.appendChild(modal);
}

/**
 * Admin → Menu visibility tab. Lets the admin tick which sidebar items
 * are visible for everyone in this tenant. Saves to config.HIDDEN_NAV_IDS
 * as a CSV. The frontend reads it from /config.json on next load and
 * filters NAV accordingly. Three quick-action items (newleads, overdue,
 * upcoming) live as chips in the topbar regardless — hiding them just
 * removes the duplicate sidebar entries.
 */
async function adminMenuVisibility() {
  const cfg = await api('api_admin_getConfig');
  const hidden = new Set(String(cfg.HIDDEN_NAV_IDS || 'newleads,overdue,duetoday,upcoming,dialer')
    .split(',').map(s => s.trim()).filter(Boolean));
  const wrap = h('div', {});
  wrap.appendChild(h('h4', { style: { margin: '0 0 .5rem' } }, '🧭 Sidebar menu visibility'));
  wrap.appendChild(h('p', { class: 'muted' },
    'Untick any item to hide it from every user in this organization. The three "quick action" items (New leads / Overdue / Upcoming) appear as chips in the topbar regardless and are hidden by default to keep the sidebar short.'));
  const list = h('div', { class: 'card', style: { padding: '1rem', maxWidth: '560px' } });
  NAV.forEach(item => {
    const row = h('label', {
      class: 'qual-toggle',
      style: { display: 'flex', alignItems: 'center', padding: '.4rem 0', cursor: 'pointer' }
    },
      h('input', {
        type: 'checkbox', 'data-nav-id': item.id,
        checked: hidden.has(item.id) ? null : 'checked',
        style: { marginRight: '.5rem' }
      }),
      h('span', { style: { fontSize: '1.1rem', marginRight: '.4rem' } }, item.icon || ''),
      h('span', { style: { fontWeight: 500 } }, item.label),
      item.roles ? h('span', { class: 'muted', style: { marginLeft: '.5rem', fontSize: '.78rem' } }, ' (' + item.roles.join('/') + ' only)') : null
    );
    list.appendChild(row);
  });
  wrap.appendChild(list);
  wrap.appendChild(h('div', { class: 'actions', style: { marginTop: '1rem' } },
    h('button', { class: 'btn primary', onclick: async () => {
      const newHidden = [];
      $$('[data-nav-id]', list).forEach(cb => {
        if (!cb.checked) newHidden.push(cb.getAttribute('data-nav-id'));
      });
      try {
        await api('api_admin_setConfig', { HIDDEN_NAV_IDS: newHidden.join(',') });
        toast('Saved — reload the page to see the change');
      } catch (e) { toast(e.message, 'err'); }
    } }, 'Save')
  ));
  return wrap;
}

async function adminChatPermissions() {
  const cfg = await api('api_chat_settings_get');
  const wrap = h('div', {});
  wrap.appendChild(h('h4', { style: { margin: '0 0 .5rem' } }, '💬 Who can use Team chat?'));
  wrap.appendChild(h('p', { class: 'muted' },
    'Pick which roles get access to the Team chat tab. Disabled roles don\'t see the sidebar entry, can\'t start DMs, and can\'t post to channels. Admin is always allowed (you can\'t lock yourself out).'));

  const allowed = new Set(cfg.allowed_roles || []);
  const labels = {
    admin: '👑 Admin', manager: '🧭 Manager', team_leader: '🎯 Team leader',
    sales: '📞 Sales / tele-caller', employee: '👤 Employee (read-only roles)'
  };
  const list = h('div', { class: 'card', style: { padding: '1rem', maxWidth: '520px' } });
  cfg.all_roles.forEach(role => {
    const isAdmin = role === 'admin';
    const row = h('label', {
      class: 'qual-toggle',
      style: { display: 'flex', alignItems: 'center', padding: '.5rem 0', cursor: isAdmin ? 'not-allowed' : 'pointer' }
    },
      h('input', {
        type: 'checkbox', name: 'role_' + role,
        checked: allowed.has(role) ? 'checked' : null,
        disabled: isAdmin ? 'disabled' : null,
        style: { marginRight: '.5rem' }
      }),
      h('span', { style: { fontWeight: 500 } }, labels[role] || role),
      isAdmin ? h('span', { class: 'muted', style: { marginLeft: '.5rem', fontSize: '.78rem' } }, ' (always allowed)') : null
    );
    list.appendChild(row);
  });
  wrap.appendChild(list);

  wrap.appendChild(h('div', { style: { marginTop: '1rem' } },
    h('button', { class: 'btn primary', onclick: async () => {
      const checks = list.querySelectorAll('input[type="checkbox"]');
      const picked = [];
      checks.forEach(c => {
        if (c.checked || c.disabled) {
          picked.push(c.name.replace(/^role_/, ''));
        }
      });
      try {
        const r = await api('api_chat_settings_save', { allowed_roles: picked });
        toast('Saved — ' + r.allowed_roles.length + ' role(s) allowed');
      } catch (e) { toast(e.message, 'err'); }
    } }, '💾 Save')
  ));

  wrap.appendChild(h('p', { class: 'muted', style: { marginTop: '1rem', fontSize: '.85rem' } },
    'Note: changes take effect when each user reloads the CRM. Active sessions on disabled roles will see "Team chat is not enabled for your role" the next time they open the chat tab.'));

  return wrap;
}

/* ---------------- Settings → Announcements ----------------------- */
async function adminAnnouncements() {
  const wrap = h('div', {});
  wrap.appendChild(h('div', { class: 'toolbar' },
    h('h4', { style: { margin: 0 } }, '📢 Announcements'),
    h('button', { class: 'btn primary', onclick: () => openAnnounceModal(null, () => showAdminTab('announce')) }, '+ New announcement')
  ));
  wrap.appendChild(h('p', { class: 'muted', style: { marginTop: '.25rem' } },
    'Banners shown at the top of every page. Choose a severity colour, optionally set an expiry, and pick whether users can dismiss. Dismissed announcements stay hidden per-user — use the "Reset" button to make everyone see it again.'));

  const rows = await api('api_announcements_list').catch(() => []);
  if (!rows.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No announcements yet.'));
    return wrap;
  }
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Title'), h('th', {}, 'Severity'), h('th', {}, 'Active'),
      h('th', {}, 'Dismissible'), h('th', {}, 'Expires'),
      h('th', {}, 'Created'), h('th', {}, '')
    )),
    h('tbody', {}, ...rows.map(r => h('tr', {},
      h('td', {}, h('b', {}, r.title)),
      h('td', {}, h('span', { class: 'tag', style: { background: ANNOUNCE_COLORS[r.severity] || '#94a3b8', color: '#fff' } }, r.severity)),
      h('td', {}, r.is_active ? '✓' : '—'),
      h('td', {}, r.is_dismissible ? '✓' : '🔒 sticky'),
      h('td', { class: 'muted' }, r.expires_at ? fmtDate(r.expires_at, 'relative') : '—'),
      h('td', { class: 'muted' }, fmtDate(r.created_at, 'relative')),
      h('td', { style: { whiteSpace: 'nowrap' } },
        h('button', { class: 'btn sm', onclick: () => openAnnounceModal(r, () => showAdminTab('announce')) }, '✎'),
        h('button', { class: 'btn sm ghost', style: { marginLeft: '.25rem' },
          onclick: async () => {
            if (!confirm('Reset dismissals — every user will see this banner again?')) return;
            try { const x = await api('api_announcements_resetDismissals', r.id); toast('Reset for ' + x.cleared + ' users'); }
            catch (e) { toast(e.message, 'err'); }
          },
          title: 'Reset dismissals — show to all users again'
        }, '↻'),
        h('button', { class: 'btn sm ghost', style: { marginLeft: '.25rem' },
          onclick: async () => {
            if (!confirm('Permanently delete this announcement?')) return;
            try { await api('api_announcements_delete', r.id); toast('Deleted'); showAdminTab('announce'); }
            catch (e) { toast(e.message, 'err'); }
          }
        }, '🗑')
      )
    )))
  )));
  return wrap;
}

const ANNOUNCE_COLORS = {
  info:    '#3b82f6',
  success: '#10b981',
  warning: '#f59e0b',
  danger:  '#ef4444'
};

function openAnnounceModal(initial, onSave) {
  const a = initial || { title: '', body: '', severity: 'info', is_active: 1, is_dismissible: 1, expires_at: '' };
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  m.appendChild(body);
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, initial ? 'Edit announcement' : 'New announcement'),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));
  const form = h('form', { id: 'an-form', class: 'form-grid' });
  form.append(
    field('title', 'Title *', a.title, { required: true, full: true }),
    field('body', 'Message body', a.body, { type: 'textarea', full: true }),
    selectField('severity', 'Severity', a.severity, [
      { value: 'info',    label: '🔵 Info' },
      { value: 'success', label: '🟢 Success' },
      { value: 'warning', label: '🟡 Warning' },
      { value: 'danger',  label: '🔴 Danger' }
    ]),
    field('expires_at', 'Auto-expire at (optional)', isoToLocalDtInput(a.expires_at), { type: 'datetime-local' }),
    h('div', { class: 'f-row' },
      h('label', {}, 'Active'),
      h('label', { class: 'qual-toggle' },
        h('input', { type: 'checkbox', name: 'is_active', checked: Number(a.is_active) !== 0 ? 'checked' : null }),
        ' Show on top of every screen'
      )
    ),
    h('div', { class: 'f-row' },
      h('label', {}, 'Dismissible'),
      h('label', { class: 'qual-toggle' },
        h('input', { type: 'checkbox', name: 'is_dismissible', checked: Number(a.is_dismissible) !== 0 ? 'checked' : null }),
        ' Allow users to close (uncheck for sticky / mandatory notice)'
      )
    )
  );
  body.appendChild(form);
  body.appendChild(h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'btn', onclick: () => m.remove() }, 'Cancel'),
    h('button', { type: 'submit', form: 'an-form', class: 'btn primary' }, initial ? 'Save changes' : 'Post announcement')
  ));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    const payload = {
      id: initial?.id || undefined,
      title: form.title.value.trim(),
      body: form.body.value,
      severity: form.severity.value,
      expires_at: form.expires_at.value ? new Date(form.expires_at.value).toISOString() : null,
      is_active: fd.get('is_active') ? 1 : 0,
      is_dismissible: fd.get('is_dismissible') ? 1 : 0
    };
    if (!payload.title) { toast('Title is required', 'err'); return; }
    try {
      await api('api_announcements_save', payload);
      toast(initial ? 'Saved' : 'Posted');
      m.remove();
      // Refresh the banner immediately so admin sees the result
      refreshAnnouncements();
      if (typeof onSave === 'function') onSave();
    } catch (e) { toast(e.message, 'err'); }
  });
  document.body.appendChild(m);
}

async function adminCompany() {
  const cfg = await api('api_admin_getConfig');
  const wrap = h('div', {});

  // ---- Brand identity card ----
  const card = h('div', { class: 'card brand-card' },
    h('h4', {}, '🎨 Company branding'),
    h('p', { class: 'muted' }, 'Your brand name and logo show up on the login screen, the sidebar, the topbar, and the Android app icon area.')
  );
  wrap.appendChild(card);

  // Live preview
  const previewLogo = h('div', { class: 'brand-logo-preview' });
  function setPreview(url) {
    previewLogo.innerHTML = '';
    if (url) {
      const img = h('img', { src: url, alt: 'logo' });
      img.onerror = () => { previewLogo.innerHTML = '<span class="muted">⚠️ Could not load image</span>'; };
      previewLogo.appendChild(img);
    } else {
      previewLogo.appendChild(h('span', { class: 'brand-fallback' }, '🎯'));
    }
  }
  setPreview(cfg.COMPANY_LOGO_URL);

  // Name input
  const nameInput = h('input', { type: 'text', value: cfg.COMPANY_NAME || 'Lead CRM', placeholder: 'e.g. Acme CRM' });

  card.appendChild(h('div', { class: 'brand-row' },
    h('div', { class: 'brand-logo-col' },
      h('label', {}, 'Logo'),
      previewLogo,
      h('div', { class: 'actions' },
        h('label', { class: 'btn primary brand-upload-btn' },
          '📤 Upload logo',
          h('input', {
            type: 'file', accept: 'image/png,image/jpeg,image/svg+xml,image/webp',
            style: { display: 'none' },
            onchange: async ev => {
              const f = ev.target.files[0];
              if (!f) return;
              if (f.size > 1.5 * 1024 * 1024) { toast('Logo too large — please use an image under 1.5 MB', 'warn'); return; }
              const dataUrl = await new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(r.result); r.onerror = reject;
                r.readAsDataURL(f);
              });
              try {
                await api('api_admin_uploadLogo', { data_url: dataUrl });
                setPreview(dataUrl);
                CRM.config.company_logo_url = dataUrl;
                // Refresh sidebar + topbar logos in real time
                document.querySelectorAll('img.sidebar-logo, img.login-logo, .brand-img').forEach(i => i.src = dataUrl);
                toast('Logo updated');
              } catch (e) { toast(e.message, 'err'); }
            }
          })
        ),
        cfg.COMPANY_LOGO_URL
          ? h('button', {
              class: 'btn ghost', onclick: async () => {
                if (!await confirmDialog('Remove the company logo? The 🎯 default icon will be used.')) return;
                try {
                  await api('api_admin_clearLogo');
                  setPreview('');
                  CRM.config.company_logo_url = '';
                  document.querySelectorAll('img.sidebar-logo, img.login-logo').forEach(i => i.remove());
                  toast('Logo removed');
                } catch (e) { toast(e.message, 'err'); }
              }
            }, '🗑️ Remove')
          : null
      ),
      h('p', { class: 'muted', style: { fontSize: '.8rem', marginTop: '.4rem' } },
        'Recommended: square PNG, 256×256 to 512×512, transparent background. Max 1.5 MB.'
      )
    ),
    h('div', { class: 'brand-name-col' },
      h('label', {}, 'Company name *'),
      nameInput,
      h('p', { class: 'muted', style: { fontSize: '.8rem', marginTop: '.3rem' } },
        'Shown on the login screen, sidebar, and emails.'
      ),
      h('div', { class: 'actions', style: { marginTop: '1rem' } },
        h('button', { class: 'btn primary', onclick: async () => {
          const newName = nameInput.value.trim();
          if (!newName) return toast('Name cannot be empty', 'warn');
          try {
            await api('api_admin_setConfig', { COMPANY_NAME: newName });
            CRM.config.company_name = newName;
            document.title = newName;
            const brandSpan = document.querySelector('.brand-name');
            if (brandSpan) brandSpan.textContent = newName;
            toast('Saved');
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Save name')
      )
    )
  ));

  // ---- Advanced: paste a URL instead of uploading ----
  wrap.appendChild(h('details', { class: 'card brand-advanced' },
    h('summary', {}, 'Advanced — paste a logo URL instead of uploading'),
    h('p', { class: 'muted' }, 'If you host your logo elsewhere (e.g. on a CDN), you can paste the URL here.'),
    configForm(cfg, ['COMPANY_LOGO_URL'])
  ));

  return wrap;
}

/* ---- Website API / sample CSV ---- */
async function adminApi() {
  const cfg = await api('api_admin_getConfig');
  const origin = location.origin;
  const apiKey = cfg.WEBSITE_API_KEY || '';
  const card = h('div', {});

  function rebuildCurl(key) {
    return `curl -X POST '${origin}/hook/website' \\\n  -H 'x-api-key: ${key || '<your-api-key>'}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name":"John Doe","phone":"+911234567890","email":"john@example.com","source":"Website","notes":"Demo request"}'`;
  }

  const keyEl = h('code', { id: 'admin-api-key' }, apiKey || '(not generated yet)');
  const curlEl = h('pre', { class: 'code-block', id: 'admin-curl' }, rebuildCurl(apiKey));

  async function regenerate() {
    if (!confirm('Generate a new API key? Anyone using the old key will stop working until you update them.')) return;
    try {
      const r = await api('api_admin_regenerateApiKey');
      keyEl.textContent = r.key;
      curlEl.textContent = rebuildCurl(r.key);
      toast('New API key generated');
    } catch (e) { toast(e.message, 'err'); }
  }

  card.appendChild(h('div', { class: 'card' },
    h('h4', {}, '🌐 Website lead API'),
    h('p', { class: 'muted' }, 'Send leads from your website, landing page or any external system by POSTing to this endpoint. Leads go straight into the CRM and trigger your auto-assign rules + automations.'),
    h('div', { class: 'api-endpoint' },
      h('code', {}, origin + '/hook/website'),
      h('button', { class: 'btn sm', onclick: () => { navigator.clipboard.writeText(origin + '/hook/website'); toast('URL copied'); } }, 'Copy URL')
    ),
    h('h5', {}, 'API key'),
    h('div', { class: 'api-endpoint' },
      keyEl,
      h('button', { class: 'btn sm', onclick: () => { navigator.clipboard.writeText(keyEl.textContent); toast('Key copied'); } }, 'Copy'),
      h('button', { class: 'btn sm', onclick: regenerate }, '🔄 Regenerate')
    ),
    h('p', { class: 'muted' }, 'Keep this key secret. If it ever leaks, click Regenerate to invalidate the old one. You can also set it manually below.'),
    configForm(cfg, ['WEBSITE_API_KEY']),
    h('h5', {}, 'Try it — cURL'),
    curlEl,
    h('p', { style: { marginTop: '.75rem' } },
      h('a', { href: '/api-docs', target: '_blank', class: 'btn primary' }, '📖 View full API documentation →')
    ),
    h('p', { class: 'muted' }, 'Includes JS, PHP, Python, WordPress, HTML form examples + how to send tags/labels.'),
    h('h5', {}, 'Sample CSV for bulk upload'),
    h('p', { class: 'muted' }, 'Download the template, fill in your leads, then use Leads → ⬆️ Upload to import.'),
    h('a', { class: 'btn primary', href: '/api/sample.csv', download: 'lead-crm-sample.csv' }, '⬇️ Download sample CSV')
  ));
  return card;
}

/* ---- Automations ---- */
async function adminAutomations() {
  const [automations, log] = await Promise.all([
    api('api_automations_list'),
    api('api_automations_log', 20).catch(() => [])
  ]);
  const card = h('div', {});
  card.appendChild(h('div', { class: 'card' },
    h('h4', {}, '⚡ Automations'),
    h('p', { class: 'muted' }, 'Send emails or WhatsApp messages automatically when events happen (lead created, status changed, etc). Use {{lead.name}}, {{lead.phone}}, {{user.name}}, {{new_status.name}} in your templates.')
  ));
  const tblCard = h('div', { class: 'card' });
  tblCard.appendChild(h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Event'), h('th', {}, 'Channel'),
      h('th', {}, 'Recipient'), h('th', {}, 'Active'), h('th', {})
    )),
    h('tbody', {}, ...automations.map(a => h('tr', {},
      h('td', {}, a.name),
      h('td', {}, a.event),
      h('td', {}, a.channel),
      h('td', {}, a.recipient),
      h('td', {},
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: Number(a.is_active) ? 'checked' : null,
            onclick: async ev => { try { await api('api_automations_toggle', a.id, ev.target.checked); toast('Toggled'); } catch (e) { toast(e.message, 'err'); } } }),
          h('span', { class: 'slider' })
        )
      ),
      h('td', {},
        h('button', { class: 'btn sm', onclick: () => openAutomationModal(a) }, '✎'),
        h('button', { class: 'btn sm', onclick: async () => { try { const r = await api('api_automations_test', a.id); toast(r.note || 'Test fired'); setTimeout(() => showAdminTab('automations'), 2000); } catch (e) { toast(e.message, 'err'); } } }, '▶ Test'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog('Delete automation?')) return; await api('api_automations_delete', a.id); toast('Deleted'); showAdminTab('automations'); } }, '🗑')
      )
    )))
  ));
  tblCard.appendChild(h('div', { class: 'actions', style: { marginTop: '.75rem' } },
    h('button', { class: 'btn primary', onclick: () => openAutomationModal() }, '+ New automation')
  ));
  card.appendChild(tblCard);

  if (log && log.length) {
    const logCard = h('div', { class: 'card' }, h('h4', {}, '📋 Recent log'));
    logCard.appendChild(h('table', { class: 'mini-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Automation'), h('th', {}, 'Event'), h('th', {}, 'Channel'), h('th', {}, 'Status'), h('th', {}, 'Detail'))),
      h('tbody', {}, ...log.map(r => h('tr', {},
        h('td', {}, fmtDate(r.created_at, 'relative')),
        h('td', {}, r.automation_name || '—'),
        h('td', {}, r.event),
        h('td', {}, r.channel),
        h('td', { class: r.status === 'sent' ? 'cell-ok' : r.status === 'failed' ? 'cell-err' : 'muted' }, r.status),
        h('td', {}, (r.detail || '').slice(0, 60))
      )))
    ));
    card.appendChild(logCard);
  }
  return card;
}

function openAutomationModal(existing) {
  const a = existing || { name: '', event: 'lead_created', channel: 'email', recipient: 'lead', condition: '', subject: '', template: '', is_active: 1 };
  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' }, h('h3', {}, a.id ? 'Edit automation' : 'New automation'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('form', { id: 'auto-form', class: 'form-grid' },
        field('name', 'Name *', a.name, { required: true }),
        selectField('event', 'When (event) *', a.event, [
          { value: 'lead_created',   label: 'Lead created' },
          { value: 'status_changed', label: 'Status changed' },
          { value: 'lead_assigned',  label: 'Lead assigned' },
          { value: 'followup_due',   label: 'Follow-up due' }
        ]),
        selectField('channel', 'Channel *', a.channel, [
          { value: 'email',    label: 'Email (SMTP)' },
          { value: 'whatsapp', label: 'WhatsApp' },
          { value: 'webhook',  label: 'Webhook (POST URL)' }
        ]),
        selectField('recipient', 'Send to', a.recipient, [
          { value: 'lead',     label: 'The lead' },
          { value: 'assignee', label: 'Assigned user' },
          { value: 'admin',    label: 'Admin' }
        ]),
        h('div', { class: 'f-row full' },
          h('label', {}, 'Condition (optional)'),
          h('input', { name: 'condition', value: a.condition || '', placeholder: 'e.g. status=Qualified   or   source=Website   or   tag:vip' })
        ),
        h('div', { class: 'f-row full', id: 'auto-subject-row' },
          h('label', {}, 'Email subject (email only)'),
          h('input', { name: 'subject', value: a.subject || '', placeholder: 'New lead: {{lead.name}}' })
        ),
        h('div', { class: 'f-row full', id: 'auto-wa-template-row', hidden: true },
          h('label', {}, 'WhatsApp template (from Meta) *'),
          h('div', { class: 'toolbar' },
            h('select', { id: 'wa-template-select', style: { flex: 1 } },
              h('option', { value: '' }, '— pick an APPROVED template —')
            ),
            h('button', { type: 'button', class: 'btn', onclick: loadWATemplates }, '🔄 Refresh')
          ),
          h('small', { class: 'muted' }, 'Only APPROVED Meta templates can be sent. The message goes exactly as Meta approved it — variables below are filled per recipient at send time.')
        ),
        // Variables panel — auto-renders one input per body param of the
        // selected WhatsApp template, with sensible defaults.
        h('div', { class: 'f-row full', id: 'auto-wa-vars-row', hidden: true },
          h('label', {}, 'Template variables'),
          h('div', { id: 'auto-wa-vars-container' })
        ),
        h('div', { class: 'f-row full', id: 'auto-template-row' },
          h('label', {}, 'Template / body (email channel) — supports {{lead.name}}, {{lead.phone}}, {{lead.status_name}}, {{user.name}}, {{new_status.name}}, {{date}}'),
          h('textarea', { name: 'template', rows: 5, placeholder: 'Hi {{lead.name}}, your status is now {{new_status.name}}. We\'ll get back to you shortly.' }, a.template || '')
        )
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const f = $('#auto-form');
          const fd = new FormData(f);
          const name      = String(fd.get('name')      || '').trim();
          const eventKey  = String(fd.get('event')     || '').trim();
          const channel   = String(fd.get('channel')   || '').trim();
          const recipient = String(fd.get('recipient') || 'lead');
          const condition = String(fd.get('condition') || '');
          let template    = String(fd.get('template')  || '').trim();
          let subject     = String(fd.get('subject')   || '');
          const waSel = $('#wa-template-select');
          if (channel === 'whatsapp') {
            // For WhatsApp channel, the template comes from the APPROVED
            // template list — no free-form body text. We store the template
            // name in `subject` (template:<name>:<lang>) and the variables
            // pipe-separated in `template`. The runtime sender pulls them
            // both apart and calls Meta's API with the correct components.
            if (!waSel || !waSel.value) { toast('Pick an APPROVED WhatsApp template', 'err'); return; }
            const opt = waSel.options[waSel.selectedIndex];
            subject = 'template:' + waSel.value + ':' + (opt.dataset.lang || 'en_US');
            // Collect variables (one input per {{N}} in the template body)
            const varInputs = [...document.querySelectorAll('#auto-wa-vars-container input.wa-var')];
            template = varInputs.map(i => String(i.value || '').trim()).join('|');
            // Empty variables are fine — Meta accepts blank substitutions.
            // But to satisfy the server's "template required" check, set a
            // placeholder if there are zero body params.
            if (!template) template = '_';
          }
          // Friendlier client-side validation
          const missing = [];
          if (!name)     missing.push('Name');
          if (!eventKey) missing.push('Event');
          if (!channel)  missing.push('Channel');
          if (channel === 'email' && !template) missing.push('Email body');
          if (channel === 'whatsapp' && !subject.startsWith('template:')) missing.push('WhatsApp template');
          if (missing.length) { toast('Fill in: ' + missing.join(', '), 'err'); return; }
          const payload = { id: a.id, name, event: eventKey, channel,
            recipient, condition, subject, template, is_active: 1 };
          try { await api('api_automations_save', payload); toast('Saved'); modal.remove(); showAdminTab('automations'); }
          catch (e) { toast(e.message, 'err'); }
        } }, 'Save')
      )
    )
  );
  document.body.appendChild(modal);
  // Wire channel change to reveal/hide subject vs WA template row
  const chSel = modal.querySelector('select[name="channel"]');
  if (chSel) chSel.addEventListener('change', () => toggleChannelUI(chSel.value));
  toggleChannelUI(a.channel);
  // Wire template-select change so variable inputs render when the user
  // picks a different template.
  setTimeout(() => {
    const waSel = $('#wa-template-select');
    if (waSel) waSel.addEventListener('change', renderWaVarsForSelected);
  }, 100);
  // Pre-fill WA template dropdown on edit + render its variables
  if (a.channel === 'whatsapp' && String(a.subject || '').startsWith('template:')) {
    loadWATemplates().then(() => {
      const parts = a.subject.split(':');
      const sel = $('#wa-template-select');
      if (sel) {
        sel.value = parts[1] || '';
        sel.addEventListener('change', renderWaVarsForSelected);
        renderWaVarsForSelected();
      }
    });
  }
}

function toggleChannelUI(channel) {
  const sub      = $('#auto-subject-row');
  const wa       = $('#auto-wa-template-row');
  const waVars   = $('#auto-wa-vars-row');
  const tplBody  = $('#auto-template-row');
  if (sub)     sub.hidden     = channel !== 'email';
  if (wa)      wa.hidden      = channel !== 'whatsapp';
  if (waVars)  waVars.hidden  = channel !== 'whatsapp';
  // Email channel uses the free-form body textarea; WhatsApp doesn't
  if (tplBody) tplBody.hidden = channel === 'whatsapp';
  if (channel === 'whatsapp') loadWATemplates().then(() => renderWaVarsForSelected());
}

/**
 * Read the currently-selected WA template, look up its body_params count,
 * and render that many variable inputs in #auto-wa-vars-container.
 *
 * Pre-fills sensible defaults for new automations:
 *   var1 → {{lead.name}}, var2 → {{lead.phone}}, var3 → {{lead.email}}
 * For EDIT, parses the existing pipe-separated value out of the textarea
 * (which is the persisted format).
 */
function renderWaVarsForSelected() {
  const sel  = $('#wa-template-select');
  const cont = $('#auto-wa-vars-container');
  if (!sel || !cont) return;
  // Pull the selected template's option label, which contains "(N params)"
  const opt = sel.options[sel.selectedIndex];
  const label = opt ? opt.textContent : '';
  const m = label.match(/(\d+)\s*params/);
  const paramCount = m ? Number(m[1]) : 0;
  cont.innerHTML = '';
  if (!sel.value) {
    cont.appendChild(h('p', { class: 'muted', style: { fontSize: '.8rem', margin: 0 } },
      'Pick a template first.'));
    return;
  }
  if (paramCount === 0) {
    cont.appendChild(h('p', { class: 'muted', style: { fontSize: '.8rem', margin: 0 } },
      '✓ This template has no variables — it sends as-is.'));
    return;
  }
  // Existing values from the persisted textarea (pipe-separated)
  const existing = String($('#auto-form')?.elements?.template?.value || '').split('|');
  const defaults = ['{{lead.name}}', '{{lead.phone}}', '{{lead.email}}', '{{lead.source}}', '{{lead.status_name}}'];
  for (let i = 0; i < paramCount; i++) {
    cont.appendChild(h('div', { style: { marginBottom: '.4rem' } },
      h('label', { class: 'muted', style: { fontSize: '.75rem' } }, 'Variable {{' + (i + 1) + '}}'),
      h('input', {
        class: 'wa-var',
        value: (existing[i] && existing[i] !== '_') ? existing[i] : (defaults[i] || ''),
        placeholder: defaults[i] || 'value or {{lead.field}}'
      })
    ));
  }
  cont.appendChild(h('p', { class: 'muted', style: { fontSize: '.75rem', marginTop: '.4rem' } },
    'Use {{lead.name}}, {{lead.phone}}, {{lead.email}}, {{lead.status_name}}, {{user.name}}, {{date}} or any other lead field as variables. They\'re resolved per recipient at send time.'));
}

async function loadWATemplates() {
  const sel = $('#wa-template-select');
  if (!sel) return;
  // Preserve existing selection
  const current = sel.value;
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const { templates, error } = await api('api_whatsapp_templates');
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: '' }, '— free-form text (session message, 24h window) —'));
    if (error) {
      sel.appendChild(h('option', { value: '', disabled: true }, 'Error: ' + error));
      return;
    }
    if (!templates.length) {
      sel.appendChild(h('option', { value: '', disabled: true }, 'No templates — add WABA ID + token in Settings → WhatsApp'));
      return;
    }
    templates.forEach(t => {
      const label = `${t.name} (${t.language}${t.body_params ? ', ' + t.body_params + ' params' : ''}) — ${t.status}`;
      sel.appendChild(h('option', { value: t.name, 'data-lang': t.language }, label));
    });
    if (current) sel.value = current;
  } catch (e) {
    sel.innerHTML = '<option value="" disabled>Error: ' + e.message + '</option>';
  }
}
async function adminFb() {
  // Pull live state — settings, status, page list, lookup data for the dropdowns.
  const [settings, status, pages, sources, statuses, users] = await Promise.all([
    api('api_fb_settings_get').catch(e => { console.warn(e); return {}; }),
    api('api_fb_status').catch(() => ({ connected: false })),
    api('api_fb_pages_list').catch(() => []),
    api('api_sources_list').catch(() => []),
    api('api_statuses_list').catch(() => []),
    api('api_users_list').catch(() => [])
  ]);

  // Preload the FB SDK so when the user clicks "Connect with Facebook",
  // FB.login() runs synchronously inside the click event and the browser
  // allows the popup. If the SDK only loads on click, Chrome blocks the
  // popup because the user gesture has already expired.
  if (settings && settings.app_id) {
    ensureFbSdkLoaded(settings.app_id).catch(e => console.warn('FB SDK preload:', e.message));
  }

  const wrap = h('div', { class: 'fb-admin' });
  wrap.appendChild(h('h3', { style: { margin: '0 0 1rem' } }, 'Facebook Leads Integration'));

  // ============ 1. Application Settings ============
  // Platform-managed Meta App credentials — admins never input these. The
  // App ID + Secret are baked into the backend (same Meta Developer App as
  // the WhatsApp Cloud API integration). Showing an info card instead of
  // input fields keeps admins from needing to know the App ID / Secret.
  if (settings.fb_platform_managed) {
    const appCard = h('div', { class: 'card', style: { borderLeft: '4px solid #10b981' } });
    appCard.appendChild(h('h4', { style: { marginTop: 0 } }, '🔒 Facebook Application — managed for you'));
    appCard.appendChild(h('p', { class: 'muted', style: { marginBottom: 0 } },
      'The Facebook App ID and Secret used for this integration are pre-configured by the platform. ',
      'You only need to fill in Module Settings below and connect your Facebook pages.'
    ));
    wrap.appendChild(appCard);
  } else {
    const appCard = h('div', { class: 'card' });
    appCard.appendChild(h('h4', { style: { marginTop: 0 } }, 'Facebook Application Settings'));
    const appForm = h('form', { class: 'form-grid', onsubmit: async ev => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      try {
        await api('api_fb_settings_set', {
          app_id: fd.get('app_id'),
          app_secret: fd.get('app_secret')   // empty = leave existing untouched
        });
        toast('Application settings saved');
        showAdminTab('fb');
      } catch (e) { toast(e.message, 'err'); }
    }});
    appForm.appendChild(h('div', { class: 'f-row full' },
      h('label', {}, 'Facebook Application ID'),
      h('input', { name: 'app_id', value: settings.app_id || '', placeholder: 'e.g. 1234567890123456' })
    ));
    appForm.appendChild(h('div', { class: 'f-row full' },
      h('label', {}, 'Facebook Application Secret',
        settings.app_secret_present ? h('span', { class: 'muted', style: { fontSize: '.75rem', marginLeft: '.4rem' } }, '(saved — leave blank to keep)') : null
      ),
      h('input', { name: 'app_secret', type: 'password', autocomplete: 'new-password',
        placeholder: settings.app_secret_present ? '••••••••••••••' : 'paste from Meta App Dashboard' })
    ));
    appForm.appendChild(h('div', { class: 'f-row full' },
      h('button', { type: 'submit', class: 'btn primary' }, '💾 Save application settings')
    ));
    appCard.appendChild(appForm);
    wrap.appendChild(appCard);
  }

  // ============ 2. Module Settings ============
  const modCard = h('div', { class: 'card' });
  modCard.appendChild(h('h4', { style: { marginTop: 0 } }, 'Module Settings'));
  const modForm = h('form', { class: 'form-grid', onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      await api('api_fb_settings_set', {
        verify_token:      fd.get('verify_token'),
        default_user_id:   fd.get('default_user_id'),
        default_source:    fd.get('default_source'),
        default_status_id: fd.get('default_status_id')
      });
      toast('Module settings saved');
    } catch (e) { toast(e.message, 'err'); }
  }});
  modForm.appendChild(h('div', { class: 'f-row full' },
    h('label', {}, 'Webhook Verify Token ',
      h('span', { class: 'muted', style: { fontWeight: 'normal' } }, '(you can change this if you want)')),
    h('input', { name: 'verify_token', value: settings.verify_token || '',
      placeholder: 'e.g. token654321 — paste this same value into Meta → Webhooks → Verify Token' })
  ));
  modForm.appendChild(h('div', { class: 'f-row full', style: { marginTop: '.5rem' } },
    h('label', {}, 'Select an operator / source / status for leads that will be captured:')
  ));
  // Three dropdowns side-by-side (matching the screenshot)
  const trio = h('div', { class: 'fb-trio' },
    h('select', { name: 'default_user_id' },
      h('option', { value: '' }, '— Use assignment rules —'),
      ...users.map(u => h('option', {
        value: u.id,
        selected: String(u.id) === String(settings.default_user_id) ? 'selected' : null
      }, u.name + (u.role ? ' (' + u.role + ')' : '')))
    ),
    h('select', { name: 'default_source' },
      ...['Facebook', 'Facebook Lead Ad', 'Instagram', 'Meta Ads', ...sources.map(s => s.name)]
        .filter((v, i, a) => v && a.indexOf(v) === i)   // dedupe
        .map(s => h('option', {
          value: s,
          selected: s === (settings.default_source || 'Facebook') ? 'selected' : null
        }, s))
    ),
    h('select', { name: 'default_status_id' },
      h('option', { value: '' }, '— Default New —'),
      ...statuses.map(s => h('option', {
        value: s.id,
        selected: String(s.id) === String(settings.default_status_id) ? 'selected' : null
      }, s.name))
    )
  );
  modForm.appendChild(h('div', { class: 'f-row full' }, trio));
  // Webhook URL display (read-only)
  modForm.appendChild(h('div', { class: 'f-row full', style: { marginTop: '.5rem' } },
    h('label', {}, 'Your unique webhook callback URL is:'),
    h('input', { value: location.origin + '/hook/meta', readonly: 'readonly',
      style: { background: '#f1f5f9', fontFamily: 'monospace', cursor: 'text' },
      onclick: ev => ev.target.select() })
  ));
  modForm.appendChild(h('div', { class: 'f-row full' },
    h('button', { type: 'submit', class: 'btn primary' }, '💾 Save module settings')
  ));
  modCard.appendChild(modForm);
  wrap.appendChild(modCard);

  // ============ 3. Pages list ============
  const pagesCard = h('div', { class: 'card' });
  pagesCard.appendChild(h('h4', { style: { marginTop: 0 } }, 'Fetch / relist Facebook pages'));
  const pagesToolbar = h('div', { class: 'toolbar', style: { marginBottom: '.75rem' } });

  // "Connect with Facebook" — only shown when not connected.
  // Uses the SERVER-SIDE OAuth flow now (no popup, no SDK, no permission needed).
  if (!status.connected) {
    pagesToolbar.appendChild(
      h('button', { class: 'btn primary', onclick: connectFacebookServerFlow }, '🔗 Connect with Facebook')
    );
    pagesToolbar.appendChild(h('span', { class: 'muted', style: { fontSize: '.85rem' } },
      'You\'ll be redirected to facebook.com to log in. Pick which pages to monitor here when you return.'
    ));
  } else {
    pagesToolbar.appendChild(
      h('button', { class: 'btn primary', onclick: async () => {
        try { const r = await api('api_fb_pages_refetch'); toast('Found ' + r.count + ' pages'); showAdminTab('fb'); }
        catch (e) { toast(e.message, 'err'); }
      } }, '🔄 Fetch Facebook Pages')
    );
    pagesToolbar.appendChild(
      h('button', { class: 'btn ghost', onclick: connectFacebookServerFlow }, '🔁 Re-login (different account)')
    );
    pagesToolbar.appendChild(
      h('button', { class: 'btn ghost', onclick: openFbDebugModal, title: 'Show what Facebook is actually returning for this connection' }, '🔍 Debug')
    );
    pagesToolbar.appendChild(
      h('button', { class: 'btn ghost', onclick: async () => {
        if (!await confirmDialog('Disconnect Facebook? This will unsubscribe all monitored pages.')) return;
        try { await api('api_fb_disconnect'); toast('Disconnected'); showAdminTab('fb'); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Disconnect')
    );
  }
  pagesCard.appendChild(pagesToolbar);

  // Show a flash message if we just came back from a server-side OAuth callback.
  // The callback redirects us with ?fb=<status> in the URL; surface it as a toast.
  try {
    const flash = new URLSearchParams(location.search).get('fb');
    if (flash) {
      if (flash.startsWith('connected:')) {
        const n = flash.split(':')[1];
        toast(`Connected — ${n} page${n === '1' ? '' : 's'} fetched. Pick which to monitor below.`);
      } else if (flash.startsWith('error:')) {
        toast(decodeURIComponent(flash), 'err');
      }
      history.replaceState({}, '', location.pathname + location.hash);
    }
  } catch (_) { /* ignore */ }

  // ---- Manual page registration (no OAuth) ----
  // Lets the admin paste a Page ID + a Page Access Token they obtained from
  // Graph API Explorer or a System User in Business Manager. Bypasses the
  // entire OAuth dance — useful when the app isn't approved for
  // business_management yet, or for never-expiring System User tokens.
  pagesCard.appendChild(h('details', { class: 'fb-manual-add', style: { marginTop: '1rem' } },
    h('summary', { style: { cursor: 'pointer', fontWeight: 600, color: 'var(--brand)' } },
      '➕ Add a page manually (no OAuth — paste a Page Access Token)'),
    h('div', { style: { marginTop: '.75rem' } },
      h('p', { class: 'muted', style: { fontSize: '.85rem', marginBottom: '.5rem' } },
        'Skip the Facebook login flow. Get a Page Access Token from ',
        h('a', { href: 'https://developers.facebook.com/tools/explorer/', target: '_blank', style: { color: 'var(--brand)' } }, 'Graph API Explorer'),
        ' (select your app → Get Token → User Token → grant pages_show_list, pages_manage_metadata, leads_retrieval, pages_read_engagement → then click "Get Page Access Token" and pick the page) — or generate one in Business Manager → System Users.'),
      h('form', { class: 'form-grid', onsubmit: async ev => {
        ev.preventDefault();
        const f = ev.target;
        const submitBtn = f.querySelector('button[type=submit]');
        submitBtn.disabled = 'disabled'; submitBtn.textContent = 'Validating…';
        try {
          const r = await api('api_fb_pages_addManual', {
            page_id: f.page_id.value.trim(),
            page_access_token: f.page_access_token.value.trim(),
            page_name: f.page_name.value.trim()
          });
          toast(`Added ${r.page.page_name} — now monitoring leadgen.`);
          showAdminTab('fb');
        } catch (e) {
          toast(e.message, 'err');
        } finally {
          submitBtn.disabled = null; submitBtn.textContent = 'Validate & add page';
        }
      }},
        h('div', { class: 'f-row' },
          h('label', {}, 'Page ID *'),
          h('input', { name: 'page_id', placeholder: 'e.g. 100012345678901', required: true,
            style: { fontFamily: 'monospace' } })
        ),
        h('div', { class: 'f-row' },
          h('label', {}, 'Page name (optional)'),
          h('input', { name: 'page_name', placeholder: 'auto-detected if blank' })
        ),
        h('div', { class: 'f-row full' },
          h('label', {}, 'Page Access Token *'),
          h('textarea', { name: 'page_access_token', rows: '3', required: true,
            placeholder: 'EAAB... (paste the long token from Graph API Explorer)',
            style: { fontFamily: 'monospace', fontSize: '.8rem' } })
        ),
        h('div', { class: 'f-row full' },
          h('button', { type: 'submit', class: 'btn primary' }, 'Validate & add page')
        )
      )
    )
  ));

  if (status.connected && pages.length === 0) {
    pagesCard.appendChild(h('p', { class: 'muted' },
      'Connected, but no pages are showing yet. Click ', h('b', {}, 'Fetch Facebook Pages'), ' to load them.'
    ));
  }

  if (pages.length > 0) {
    const tbl = h('table', { class: 'mini-table fb-pages' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Page Name'), h('th', { style: { textAlign: 'right' } }, 'Action')
      )),
      h('tbody', {}, ...pages.map(pg => h('tr', {},
        h('td', {},
          h('div', {}, pg.page_name || ('Page ' + pg.page_id)),
          pg.category ? h('div', { class: 'muted', style: { fontSize: '.75rem' } }, pg.category) : null
        ),
        h('td', { style: { textAlign: 'right' } },
          pg.is_monitored
            ? h('button', { class: 'btn sm danger', onclick: async () => {
                try { await api('api_fb_pages_toggle', pg.page_id, false); toast('Unmonitored ' + pg.page_name); showAdminTab('fb'); }
                catch (e) { toast(e.message, 'err'); }
              } }, 'Unmonitor')
            : h('button', { class: 'btn sm primary', onclick: async () => {
                try { await api('api_fb_pages_toggle', pg.page_id, true); toast('Monitoring ' + pg.page_name); showAdminTab('fb'); }
                catch (e) { toast(e.message, 'err'); }
              } }, 'Monitor')
        )
      )))
    );
    pagesCard.appendChild(tbl);
  }

  wrap.appendChild(pagesCard);
  return wrap;
}
async function adminWhatsapp() {
  const cfg = await api('api_admin_getConfig');
  const card = h('div', {});
  card.appendChild(configForm(cfg, ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_VERIFY_TOKEN']));
  card.appendChild(h('div', { class: 'card' },
    h('h4', {}, 'Test'),
    h('button', { class: 'btn', onclick: async () => { const r = await api('api_admin_testWhatsApp'); toast(r.ok ? 'Verified: ' + r.phone.verified_name : (r.error || 'Failed'), r.ok ? 'ok' : 'err'); } }, 'Test WhatsApp'),
    h('p', { class: 'muted' }, 'Webhook URL: ', h('code', {}, location.origin + '/hook/whatsapp'))
  ));
  return card;
}
async function adminSources() {
  const sources = await api('api_sources_list');
  const card = h('div', { class: 'card' }, h('h4', {}, 'Lead sources'));
  card.appendChild(h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Active'), h('th', {}))),
    h('tbody', {}, ...sources.map(s => h('tr', {},
      h('td', {}, s.name),
      h('td', {}, Number(s.is_active) ? '✓' : '—'),
      h('td', {}, h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog(`Delete source "${s.name}"?`)) return; await api('api_sources_delete', s.id); toast('Deleted'); showAdminTab('sources'); } }, 'Delete'))
    )))
  ));
  card.appendChild(h('form', { class: 'inline-form', onsubmit: async ev => {
    ev.preventDefault();
    try { await api('api_sources_save', { name: ev.target.n.value }); toast('Added'); showAdminTab('sources'); }
    catch (e) { toast(e.message, 'err'); }
  }},
    h('input', { name: 'n', placeholder: 'New source name', required: true }),
    h('button', { type: 'submit', class: 'btn primary' }, '+ Add')
  ));
  return card;
}
async function adminStatuses() {
  const statuses = await api('api_statuses_list');
  const card = h('div', { class: 'card' }, h('h4', {}, 'Lead statuses'));
  const tbl = h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Color'), h('th', {}, 'Order'), h('th', {}, 'Final'), h('th', {}))),
    h('tbody', {}, ...statuses.map(s => h('tr', {},
      h('td', {}, h('input', { value: s.name, 'data-id': s.id, 'data-field': 'name' })),
      h('td', {}, h('input', { type: 'color', value: s.color, 'data-id': s.id, 'data-field': 'color' })),
      h('td', {}, h('input', { type: 'number', value: s.sort_order, style: { width: '70px' }, 'data-id': s.id, 'data-field': 'sort_order' })),
      h('td', {}, h('input', { type: 'checkbox', checked: Number(s.is_final) ? 'checked' : null, 'data-id': s.id, 'data-field': 'is_final' })),
      h('td', {},
        h('button', { class: 'btn sm', onclick: async () => {
          const patch = { id: s.id };
          $$(`[data-id="${s.id}"]`, tbl).forEach(inp => {
            const f = inp.dataset.field;
            patch[f] = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : inp.value;
          });
          try { await api('api_statuses_save', patch); toast('Saved'); } catch (e) { toast(e.message, 'err'); }
        } }, '💾'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!await confirmDialog(`Delete status "${s.name}"?`)) return;
          try { await api('api_statuses_delete', s.id); toast('Deleted'); showAdminTab('statuses'); } catch (e) { toast(e.message, 'err'); }
        } }, 'Delete')
      )
    )))
  );
  card.appendChild(tbl);
  card.appendChild(h('form', { class: 'inline-form', onsubmit: async ev => {
    ev.preventDefault();
    const f = ev.target;
    try { await api('api_statuses_save', { name: f.n.value, color: f.c.value, sort_order: Number(f.o.value) || 10, is_final: f.fi.checked ? 1 : 0 }); toast('Added'); showAdminTab('statuses'); }
    catch (e) { toast(e.message, 'err'); }
  }},
    h('input', { name: 'n', placeholder: 'Status name', required: true }),
    h('input', { name: 'c', type: 'color', value: '#6366f1' }),
    h('input', { name: 'o', type: 'number', placeholder: 'Order', value: 100, style: { width: '70px' } }),
    h('label', { class: 'cb' }, h('input', { name: 'fi', type: 'checkbox' }), ' Final'),
    h('button', { type: 'submit', class: 'btn primary' }, '+ Add status')
  ));
  return card;
}
/**
 * Admin → Tags. Lets the admin maintain a master list of tags that
 * non-admin users can choose from on the lead form. Non-admin users
 * cannot create new tags; this prevents tag sprawl.
 */
async function adminTags() {
  const wrap = h('div', {});
  const tags = await api('api_tags_list');
  const colorPick = h('input', { type: 'color', value: '#6366f1', style: { width: '50px' } });
  const nameInput = h('input', { placeholder: 'Tag name (e.g. VIP, Hot, Cold)', style: { flex: '1' } });
  wrap.appendChild(h('div', { class: 'card' },
    h('h3', {}, 'Add a new tag'),
    h('p', { class: 'muted' }, 'Only admins can add tags. Other users will see this list as a multi-select on the lead form.'),
    h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.5rem' } },
      nameInput, colorPick,
      h('button', { class: 'btn primary', onclick: async () => {
        const name = String(nameInput.value || '').trim();
        if (!name) { toast('Tag name required', 'err'); return; }
        try {
          await api('api_tags_save', { name, color: colorPick.value });
          toast('Tag added');
          CRM.cache.tagLibrary = null; // force re-fetch
          showAdminTab('tags'); // refresh
        } catch (e) { toast(e.message, 'err'); }
      } }, '+ Add tag')
    )
  ));

  const list = h('div', { class: 'card' }, h('h3', {}, 'Existing tags (' + tags.length + ')'));
  if (tags.length === 0) {
    list.appendChild(h('p', { class: 'muted' }, 'No tags yet. Add some above.'));
  } else {
    list.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Color'), h('th', {}, 'Preview'), h('th', { style: { textAlign: 'right' } }, 'Actions'))),
      h('tbody', {}, ...tags.map(t => h('tr', {},
        h('td', {}, t.name),
        h('td', {}, h('code', {}, t.color)),
        h('td', {}, h('span', { class: 'tag', style: { background: t.color, color: '#fff' } }, t.name)),
        h('td', { style: { textAlign: 'right' } },
          h('button', { class: 'btn sm', onclick: async () => {
            if (!confirm(`Delete tag "${t.name}"? Existing leads tagged with this name will keep showing it but new leads cannot pick it.`)) return;
            try {
              await api('api_tags_delete', t.id);
              toast('Deleted');
              CRM.cache.tagLibrary = null;
              showAdminTab('tags');
            } catch (e) { toast(e.message, 'err'); }
          } }, '🗑️ Delete')
        )
      )))
    )));
  }
  wrap.appendChild(list);
  return wrap;
}

/**
 * Admin → TAT thresholds. One row per status with a "max minutes in this
 * stage before we escalate" input. Active toggle lets the admin pause
 * enforcement per-stage without losing the configured value.
 */
async function adminTat() {
  const wrap = h('div', {});
  const rows = await api('api_tat_thresholds_list');
  wrap.appendChild(h('div', { class: 'card' },
    h('h3', {}, '⏱️ TAT thresholds per stage'),
    h('p', { class: 'muted' },
      'Set the maximum time a lead can sit in each stage before escalation. ' +
      'Reminder timing: at threshold (employee) → 2× (manager) → 3× (admin). ' +
      'Leave blank or untick to disable enforcement for that stage.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', {}, 'Threshold (minutes)'), h('th', {}, 'Active'), h('th', { style: { textAlign: 'right' } }, ''))),
      h('tbody', {}, ...rows.map(r => {
        const minInput = h('input', { type: 'number', min: '1', value: r.threshold_minutes ?? '', placeholder: 'e.g. 60', style: { width: '110px' } });
        const activeChk = h('input', { type: 'checkbox', checked: r.is_active ? 'checked' : null });
        return h('tr', {},
          h('td', {}, h('span', { class: 'tag', style: { background: r.status_color, color: '#fff' } }, r.status_name)),
          h('td', {}, minInput),
          h('td', {}, activeChk),
          h('td', { style: { textAlign: 'right' } },
            h('button', { class: 'btn sm primary', onclick: async () => {
              try {
                await api('api_tat_thresholds_save', r.status_id, Number(minInput.value) || 60, activeChk.checked ? 1 : 0);
                toast('Saved');
              } catch (e) { toast(e.message, 'err'); }
            } }, 'Save')
          )
        );
      }))
    ))
  ));
  return wrap;
}

async function adminCustomFields() {
  const fields = await api('api_customFields_list');
  const card = h('div', { class: 'card' }, h('h4', {}, 'Custom lead fields'));
  card.appendChild(h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Key'), h('th', {}, 'Label'), h('th', {}, 'Type'),
      h('th', {}, 'Options'), h('th', {}, 'Sort'),
      h('th', {}, 'In list'), h('th', {}, 'Required'), h('th', {})
    )),
    h('tbody', {}, ...(fields.length === 0
      ? [h('tr', {}, h('td', { colspan: 8, class: 'muted', style: { textAlign: 'center', padding: '1rem' } }, 'No custom fields yet — add one below.'))]
      : fields.map(f => h('tr', {},
          h('td', {}, h('code', {}, f.key)),
          h('td', {}, f.label),
          h('td', {}, f.field_type),
          h('td', { class: 'muted' }, Array.isArray(f.options) ? f.options.join(', ') : (f.options || '—')),
          h('td', {}, String(f.sort_order || 0)),
          h('td', {}, f.show_in_list ? '✓' : '—'),
          h('td', {}, f.is_required ? '✓' : '—'),
          h('td', { style: { whiteSpace: 'nowrap' } },
            h('button', { class: 'btn sm', onclick: () => editCustomField(f) }, '✏️ Edit'),
            h('button', { class: 'btn sm danger', style: { marginLeft: '.3rem' },
              onclick: async () => {
                if (!await confirmDialog(`Delete field "${f.label}"?`)) return;
                try { await api('api_customFields_delete', f.id); toast('Deleted'); await warmCache(); showAdminTab('customfields'); }
                catch (e) { toast(e.message, 'err'); }
              }
            }, '🗑️')
          )
    )))
  )));

  // ---- "Add new field" form ----
  card.appendChild(h('h5', { style: { marginTop: '1.25rem' } }, '+ Add new field'));
  card.appendChild(buildCustomFieldForm({}, async (payload) => {
    await api('api_customFields_save', payload);
    toast('Added');
    await warmCache();
    showAdminTab('customfields');
  }, 'Add field'));
  return card;
}

/** Open a modal to edit an existing custom field. */
function editCustomField(field) {
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target === modal) modal.remove(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '✏️ Edit custom field: ' + field.label),
        h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
      ),
      h('p', { class: 'muted', style: { fontSize: '.85rem' } },
        'Note: changing the ', h('code', {}, 'key'), ' may break older data references — only do it if no leads have used this field yet.'
      ),
      buildCustomFieldForm(field, async (payload) => {
        payload.id = field.id;
        await api('api_customFields_save', payload);
        toast('Saved');
        modal.remove();
        await warmCache();
        showAdminTab('customfields');
      }, 'Save changes', () => modal.remove())
    )
  );
  document.body.appendChild(modal);
}

/** Shared form for create/edit. `onSave` receives the field payload. */
function buildCustomFieldForm(initial, onSave, submitLabel, onCancel) {
  const optsString = Array.isArray(initial.options) ? initial.options.join('|') : (initial.options || '');

  // --- Options field (textarea + chip preview, only visible for select/multiselect) ---
  const optsTextarea = h('textarea', {
    name: 'options',
    placeholder: 'One option per line, e.g.\nLow\nMedium\nHigh',
    rows: '4'
  });
  optsTextarea.value = optsString.replace(/\|/g, '\n');
  const chipsBox = h('div', { class: 'cf-opts-chips' });
  const optsHelp = h('div', { class: 'cf-opts-help' },
    'Type one option per line (or separate with commas / pipes). These are the choices the user picks from on the lead form.');
  function renderChips() {
    chipsBox.innerHTML = '';
    parseFieldOptions(optsTextarea.value).forEach(o =>
      chipsBox.appendChild(h('span', { class: 'cf-opts-chip' }, o)));
  }
  optsTextarea.addEventListener('input', renderChips);
  const optsRow = h('div', { class: 'f-row full' },
    h('label', {}, 'Options *'),
    optsTextarea, optsHelp, chipsBox
  );

  // --- Type selector — toggles the visibility of the Options row ---
  const typeRow = selectField('field_type', 'Type', initial.field_type || 'text',
    ['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox']);
  const typeSelect = typeRow.querySelector('select');
  function syncOptsVisibility() {
    const needsOpts = typeSelect.value === 'select' || typeSelect.value === 'multiselect';
    optsRow.style.display = needsOpts ? '' : 'none';
    optsTextarea.toggleAttribute('required', needsOpts);
    if (needsOpts) renderChips();
  }
  typeSelect.addEventListener('change', syncOptsVisibility);

  const form = h('form', { class: 'form-grid', onsubmit: async ev => {
    ev.preventDefault();
    const f = ev.target;
    const fieldType = f.field_type.value;
    const needsOpts = fieldType === 'select' || fieldType === 'multiselect';
    if (needsOpts && parseFieldOptions(optsTextarea.value).length === 0) {
      toast('Please add at least one option for ' + fieldType + ' fields.', 'err');
      optsTextarea.focus();
      return;
    }
    try {
      await onSave({
        key: f.key.value,
        label: f.label.value,
        field_type: fieldType,
        // Always store as pipe-separated for backwards compatibility with the DB.
        options: needsOpts ? parseFieldOptions(optsTextarea.value).join('|') : '',
        show_in_list: f.show_in_list.checked ? 1 : 0,
        is_required: f.is_required.checked ? 1 : 0,
        sort_order: Number(f.sort_order.value) || 10
      });
    } catch (e) { toast(e.message, 'err'); }
  }},
    field('key', 'Key *', initial.key || '', { required: true }),
    field('label', 'Label *', initial.label || '', { required: true }),
    typeRow,
    optsRow,
    field('sort_order', 'Sort order', String(initial.sort_order != null ? initial.sort_order : 10), { type: 'number' }),
    h('div', { class: 'f-row' }, h('label', { class: 'cb' },
      h('input', { name: 'show_in_list', type: 'checkbox', checked: initial.show_in_list ? 'checked' : null }),
      ' Show in lead list')),
    h('div', { class: 'f-row' }, h('label', { class: 'cb' },
      h('input', { name: 'is_required', type: 'checkbox', checked: initial.is_required ? 'checked' : null }),
      ' Required')),
    h('div', { class: 'f-row full actions' },
      onCancel ? h('button', { type: 'button', class: 'btn', onclick: onCancel }, 'Cancel') : null,
      h('button', { type: 'submit', class: 'btn primary' }, submitLabel)
    )
  );

  // Initial visibility + chip render once the form is mounted.
  syncOptsVisibility();
  renderChips();
  return form;
}
async function adminRules() {
  const wrap = h('div', {});

  // ---- Auto-dial toggle (push "📞 tap to call" to assignee on new lead) ----
  try {
    const cfg = await api('api_admin_getConfig');
    const autoOn = String(cfg.LEAD_AUTODIAL_ON || '1') === '1';
    const adCard = h('div', { class: 'card', style: { marginBottom: '1rem' } });
    adCard.appendChild(h('h4', { style: { marginTop: 0 } }, '📞 Auto-dial on new lead'));
    adCard.appendChild(h('p', { class: 'muted' },
      'When a new lead lands (from any source — webhook, manual entry, CSV upload), push a ',
      h('b', {}, 'Tap to call'),
      ' notification to the assignee\'s mobile. Tapping the notification opens the dialer with the lead\'s number pre-filled. ',
      h('b', {}, 'Skipped for admins'),
      ' (admins don\'t work the pipeline) and any rep who has turned auto-dial off in their own profile (Users → Edit → Auto-dial preference). Also skipped for leads moved to Junk.'));
    adCard.appendChild(h('label', { class: 'toggle-row', style: { display: 'flex', alignItems: 'center', gap: '.5rem' } },
      h('input', { type: 'checkbox', checked: autoOn ? 'checked' : null,
        onchange: async ev => {
          try {
            await api('api_admin_setConfig', { LEAD_AUTODIAL_ON: ev.target.checked ? '1' : '0' });
            toast(ev.target.checked ? 'Auto-dial ON' : 'Auto-dial OFF');
          } catch (e) {
            toast(e.message, 'err');
            ev.target.checked = !ev.target.checked;
          }
        }
      }),
      h('span', {}, 'Auto-dial enabled — assignee gets a tap-to-call push for every new lead')
    ));
    wrap.appendChild(adCard);

    // ---- AI call summary / transcription toggle ----
    const aiOn = String(cfg.AI_TRANSCRIPTION_ENABLED == null ? '1' : cfg.AI_TRANSCRIPTION_ENABLED) === '1';
    const aiCard = h('div', { class: 'card', style: { marginBottom: '1rem' } });
    aiCard.appendChild(h('h4', { style: { marginTop: 0 } }, '🤖 AI call summary (Gemini 2.5 Flash)'));
    aiCard.appendChild(h('p', { class: 'muted' },
      'When enabled, every uploaded call recording is auto-analysed by Gemini: full transcript, 3-line summary, action items, sentiment, suggested next status, and an AI-suggested 1-5 rating. Cost: ~₹0.02 per 5-min call (Google\'s free tier covers ~750 calls/month).'
    ));
    aiCard.appendChild(h('label', { class: 'toggle-row', style: { display: 'flex', alignItems: 'center', gap: '.5rem' } },
      h('input', { type: 'checkbox', checked: aiOn ? 'checked' : null,
        onchange: async ev => {
          try {
            await api('api_admin_setConfig', { AI_TRANSCRIPTION_ENABLED: ev.target.checked ? '1' : '0' });
            toast(ev.target.checked ? 'AI transcription ON' : 'AI transcription OFF');
          } catch (e) {
            toast(e.message, 'err');
            ev.target.checked = !ev.target.checked;
          }
        }
      }),
      h('span', {}, 'Process new call recordings with Gemini AI — disable to pause spending or for privacy-sensitive tenants')
    ));
    wrap.appendChild(aiCard);
  } catch (_) { /* config endpoint missing — older deploy, skip silently */ }

  const rules = await api('api_rules_list');
  const card = h('div', { class: 'card' }, h('h4', {}, 'Auto-assign rules'));
  card.appendChild(h('p', { class: 'muted' }, 'First matching rule (by lowest priority number) wins. Assigning multiple users enables round-robin.'));
  card.appendChild(h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Priority'), h('th', {}, 'Name'), h('th', {}, 'When'), h('th', {}, 'Assign to'), h('th', {}, 'Active'), h('th', {}))),
    h('tbody', {}, ...rules.map(r => h('tr', {},
      h('td', {}, r.priority),
      h('td', {}, r.name),
      h('td', {}, `${r.field} ${r.operator} "${r.value}"`),
      h('td', {}, r.assigned_names || r.assigned_to),
      h('td', {},
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: Number(r.is_active) ? 'checked' : null,
            onclick: async ev => { try { await api('api_rules_toggle', r.id, ev.target.checked); toast('Toggled'); } catch (e) { toast(e.message, 'err'); } } }),
          h('span', { class: 'slider' })
        )
      ),
      h('td', {},
        h('button', { class: 'btn sm', onclick: () => openRuleModal(r) }, '✎'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDialog('Delete rule?')) return; await api('api_rules_delete', r.id); toast('Deleted'); showAdminTab('rules'); } }, '🗑')
      )
    )))
  ));
  card.appendChild(h('div', { class: 'actions', style: { marginTop: '1rem' } },
    h('button', { class: 'btn primary', onclick: () => openRuleModal() }, '+ New rule')
  ));
  wrap.appendChild(card);
  return wrap;
}
function openRuleModal(existing) {
  const { users } = CRM.cache;
  const r = existing || { name: '', field: 'source', operator: 'equals', value: '', assigned_to: '', priority: 100, is_active: 1 };
  const assignedIds = String(r.assigned_to || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' }, h('h3', {}, r.id ? 'Edit rule' : 'New auto-assign rule'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('form', { class: 'form-grid', id: 'rule-form' },
        field('name', 'Rule name *', r.name, { required: true }),
        selectField('field', 'Field', r.field, ['source', 'product', 'name', 'phone', 'email', 'city', 'notes', 'source_ref']),
        selectField('operator', 'Operator', r.operator, ['equals', 'contains', 'starts_with', 'ends_with']),
        field('value', 'Value *', r.value, { required: true }),
        field('priority', 'Priority (lower = first)', r.priority || 100, { type: 'number' }),
        h('div', { class: 'f-row full' },
          h('label', {}, 'Assign to (tick everyone you want → round-robin distributes across them)'),
          h('div', {
            class: 'card',
            style: { padding: '.5rem .75rem', maxHeight: '260px', overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '.25rem' }
          },
            ...users.map(u => h('label', {
              style: { display: 'flex', alignItems: 'center', gap: '.4rem', padding: '.25rem .35rem', cursor: 'pointer', borderRadius: '4px' }
            },
              h('input', {
                type: 'checkbox', class: 'rule-assignee', value: u.id,
                checked: assignedIds.includes(Number(u.id)) ? 'checked' : null
              }),
              h('span', {}, u.name),
              h('span', { class: 'muted', style: { fontSize: '.75rem' } }, ' (' + u.role + ')')
            ))
          )
        )
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const f = $('#rule-form');
          const assigned = $$('.rule-assignee:checked', f).map(cb => cb.value);
          if (!assigned.length) return toast('Pick at least one assignee', 'err');
          const payload = {
            id: r.id,
            name: f.name.value, field: f.field.value, operator: f.operator.value,
            value: f.value.value, priority: Number(f.priority.value) || 100,
            assigned_to: assigned, is_active: 1
          };
          try { await api('api_rules_save', payload); toast('Saved'); modal.remove(); showAdminTab('rules'); }
          catch (e) { toast(e.message, 'err'); }
        } }, 'Save')
      )
    )
  );
  document.body.appendChild(modal);
}
async function adminPermissions() {
  const { catalog, matrix } = await api('api_permissions_get');
  const roles = ['admin', 'manager', 'team_leader', 'sales'];
  const card = h('div', { class: 'card' },
    h('h4', {}, '🔐 Role permissions'),
    h('p', { class: 'muted' }, 'For scoped permissions (view/edit/delete leads), pick a scope: Self, Team, or Global. Admin always has full access.')
  );
  // Build matrix table
  const thead = h('thead', {}, h('tr', {}, h('th', {}, 'Permission'),
    ...roles.map(r => h('th', { style: { textTransform: 'capitalize' } }, r.replace('_', ' ')))));
  const tbody = h('tbody', {});
  catalog.forEach(p => {
    const row = h('tr', {}, h('td', {}, p.label, p.scoped ? h('span', { class: 'muted' }, ' (scoped)') : null));
    roles.forEach(role => {
      const current = matrix[role]?.[p.key];
      const cell = h('td', {});
      if (p.scoped) {
        const sel = h('select', { 'data-role': role, 'data-perm': p.key },
          h('option', { value: '0',       selected: !current ? 'selected' : null }, '— no —'),
          h('option', { value: 'self',    selected: current === 'self' ? 'selected' : null }, 'Self only'),
          h('option', { value: 'team',    selected: current === 'team' ? 'selected' : null }, 'Team'),
          h('option', { value: 'global',  selected: current === 'global' ? 'selected' : null }, 'Everyone')
        );
        cell.appendChild(sel);
      } else {
        const cb = h('input', { type: 'checkbox', 'data-role': role, 'data-perm': p.key,
          checked: current ? 'checked' : null });
        cell.appendChild(h('label', { class: 'switch' }, cb, h('span', { class: 'slider' })));
      }
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
  card.appendChild(h('div', { class: 'table-wrap scroll-x' }, h('table', { class: 'perm-matrix' }, thead, tbody)));
  card.appendChild(h('div', { class: 'actions', style: { marginTop: '1rem' } },
    h('button', { class: 'btn primary', onclick: async () => {
      const out = {};
      roles.forEach(r => { out[r] = {}; });
      $$('[data-role][data-perm]', card).forEach(el => {
        const r = el.dataset.role;
        const k = el.dataset.perm;
        if (el.type === 'checkbox') out[r][k] = el.checked ? 1 : 0;
        else {
          const v = el.value;
          out[r][k] = v === '0' ? 0 : v;
        }
      });
      try { await api('api_permissions_save', out); toast('Permissions saved'); }
      catch (e) { toast(e.message, 'err'); }
    } }, '💾 Save permissions')
  ));
  return card;
}

async function adminDuplicates() {
  const cfg = await api('api_admin_getConfig');
  return configForm(cfg, ['DUPLICATE_POLICY', 'DUPLICATE_WINDOW_HOURS', 'DUPLICATE_MATCH_FIELDS'], {
    DUPLICATE_POLICY: { type: 'select', options: ['allow', 'assign_same_user', 'skip_assignment', 'reject'],
      hint: 'allow=always create · assign_same_user=give to original assignee · skip_assignment=leave unassigned · reject=drop incoming dup' },
    DUPLICATE_WINDOW_HOURS: { hint: 'Only check dupes within this window (hours)' },
    DUPLICATE_MATCH_FIELDS: { hint: 'Comma-separated: phone, email' }
  });
}
async function adminSmtp() {
  const cfg = await api('api_admin_getConfig');
  return configForm(cfg, ['EMAIL_NOTIFY_ENABLED', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_NOTIFY_FROM', 'EMAIL_NOTIFY_SUBJECT_PREFIX', 'FOLLOWUP_REMIND_MIN'], {
    EMAIL_NOTIFY_ENABLED: { type: 'select', options: ['0', '1'], hint: '0 = off, 1 = send reminder emails' },
    SMTP_SECURE: { type: 'select', options: ['false', 'true'], hint: 'true for port 465, false for 587/STARTTLS' },
    FOLLOWUP_REMIND_MIN: { hint: 'Remind this many minutes before due_at' }
  });
}

function configForm(cfg, keys, meta) {
  meta = meta || {};
  const form = h('form', { class: 'form-grid', onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const patch = {};
    keys.forEach(k => { patch[k] = fd.get(k); });
    try { await api('api_admin_setConfig', patch); toast('Saved'); }
    catch (e) { toast(e.message, 'err'); }
  }});
  keys.forEach(k => {
    const m = meta[k] || {};
    let input;
    if (m.type === 'select') {
      input = h('select', { name: k }, ...(m.options || []).map(o => h('option', { value: o, selected: String(cfg[k]) === String(o) ? 'selected' : null }, o)));
    } else if (/password/i.test(k) || /secret/i.test(k)) {
      input = h('input', { name: k, type: 'password', value: cfg[k] || '' });
    } else {
      input = h('input', { name: k, value: cfg[k] || '' });
    }
    form.appendChild(h('div', { class: 'f-row' }, h('label', {}, k), input, m.hint ? h('small', { class: 'muted' }, m.hint) : null));
  });
  form.appendChild(h('div', { class: 'f-row full' }, h('button', { type: 'submit', class: 'btn primary' }, '💾 Save')));
  return form;
}

/* ---------------- Users ---------------- */
VIEWS.users = async (view) => {
  const users = await api('api_users_list');
  const me = CRM.user || {};
  const canReset = ['admin', 'manager'].includes(me.role);
  const canDelete = me.role === 'admin';
  view.innerHTML = '';
  view.append(
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => openUserModal() }, '+ New User')
    ),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', {}, 'Reports To'), h('th', {}, 'Department'), h('th', {}))),
      h('tbody', {}, ...users.map(u => h('tr', {},
        h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.role),
        h('td', {}, u.parent_name || '—'), h('td', {}, u.department || ''),
        h('td', { style: { whiteSpace: 'nowrap' } },
          h('button', { class: 'btn sm', onclick: () => openUserModal(u), title: 'Edit' }, '✎'),
          canReset ? h('button', {
            class: 'btn sm ghost', style: { marginLeft: '.3rem' },
            title: 'Reset password',
            onclick: () => openUserModal(u)   // opens the modal where the reset block lives
          }, '🔑') : null,
          // Delete: admin-only, hidden for self (server also enforces both rules).
          canDelete && Number(u.id) !== Number(me.id) ? h('button', {
            class: 'btn sm danger', style: { marginLeft: '.3rem' },
            title: 'Delete user',
            onclick: async () => {
              const ok = await confirmDialog(
                `Delete user "${u.name}" (${u.email})?\n\n` +
                `Their leads will be re-assigned to you. Their remarks and ` +
                `notifications will keep the lead history but lose the author. ` +
                `This cannot be undone.`
              );
              if (!ok) return;
              try {
                const r = await api('api_users_delete', u.id);
                toast(`Deleted ${u.name}. ${r.reassigned_to ? 'Their leads moved to you.' : ''}`);
                await warmCache();
                navigateTo('users');
              } catch (e) { toast(e.message, 'err'); }
            }
          }, '🗑️') : null
        )
      )))
    ))
  );
};
async function openUserModal(u) {
  u = u || { role: 'sales', is_active: 1 };
  const parents = CRM.cache.users || await api('api_users_list');
  // The password-reset section is only built for existing users — there's no
  // user_id to target until after the row is created.
  const passwordResetBlock = u.id ? buildPasswordResetBlock(u) : null;

  // Section heading helper for the user form
  const section = (title) => h('div', { class: 'f-row full', style: { marginTop: '1rem', borderTop: '1px solid var(--border-light)', paddingTop: '.75rem' } },
    h('h4', { style: { margin: 0, color: 'var(--brand)' } }, title)
  );

  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' }, h('h3', {}, u.id ? 'Edit user — ' + u.name : 'New user'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('form', { id: 'u-form', class: 'form-grid' },
        // Account credentials
        field('name', 'Name *', u.name, { required: true }),
        field('email', 'Login email *', u.email, { required: true, type: 'email' }),
        field('phone', 'Mobile / Contact number', u.phone),
        selectField('role', 'Role', u.role, ['admin', 'manager', 'team_leader', 'sales']),
        selectField('parent_id', 'Reports To', u.parent_id || '', [{ value: '', label: '— None —' }, ...parents.filter(p => p.id !== u.id).map(p => ({ value: p.id, label: p.name }))]),
        !u.id ? field('password', 'Password *', '', { type: 'password', required: true }) : null,

        // Employment
        section('💼 Employment'),
        field('department', 'Department', u.department),
        field('designation', 'Designation', u.designation),
        field('joining_date', 'Joining date', u.joining_date ? String(u.joining_date).slice(0, 10) : '', { type: 'date' }),
        field('monthly_salary', 'Monthly salary (₹)', u.monthly_salary || '', { type: 'number' }),
        field('last_company', 'Last company', u.last_company),

        // Lead capping — controls how many leads auto-assignment can
        // route to this rep per day / per month. 0 = no cap.
        section('⛔ Lead capping'),
        h('div', { class: 'f-row full' },
          h('p', { class: 'muted', style: { margin: 0, fontSize: '.82rem' } },
            'Limits how many leads auto-assignment (round-robin / website webhook / assignment rules) can route to this rep. Manual admin assignment bypasses. Set to 0 for no cap.')),
        field('daily_lead_cap',   'Daily cap (leads/day)',    u.daily_lead_cap   || 0, { type: 'number', min: 0 }),
        field('monthly_lead_cap', 'Monthly cap (leads/month)', u.monthly_lead_cap || 0, { type: 'number', min: 0 }),

        // Scheduling — when set, "📅 Send meeting link" buttons on
        // leads/customers prefill WhatsApp with this URL so prospects
        // pick a time directly.
        section('📅 Scheduling'),
        h('div', { class: 'f-row full' },
          h('p', { class: 'muted', style: { margin: 0, fontSize: '.82rem' } },
            'Paste your Calendly (or any scheduling) URL here. The CRM uses it as a "Send meeting link" shortcut on every lead and customer.')),
        field('calendly_url', 'Calendly link', u.calendly_url, { type: 'url', placeholder: 'https://calendly.com/yourname/30min' }),

        // Auto-dial — let each rep choose whether to receive the
        // "📞 Tap to call" push when a new lead lands assigned to them.
        // Default ON for new users. Hidden for admins (admins are skipped
        // server-side regardless — they're not the ones working leads).
        u.role !== 'admin' ? section('📞 Auto-dial preference') : null,
        u.role !== 'admin' ? h('div', { class: 'f-row full' },
          h('label', { class: 'toggle-row', style: { display: 'flex', alignItems: 'center', gap: '.5rem' } },
            h('input', {
              type: 'checkbox',
              name: 'autodial_on',
              value: '1',
              checked: Number(u.autodial_on != null ? u.autodial_on : 1) === 1 ? 'checked' : null
            }),
            h('span', {}, 'Send me a "Tap to call" push on every new lead assigned to me')
          )
        ) : null,
        u.role !== 'admin' ? h('div', { class: 'f-row full' },
          h('p', { class: 'muted', style: { margin: 0, fontSize: '.78rem' } },
            'When this is on and the tenant-wide auto-dial is enabled, the CRM pushes a notification to your mobile every time a new lead is assigned to you. Tap the notification → dialer opens with the number ready.')
        ) : null,
        // Webhook URL — visible only when editing your own profile (or
        // admin editing someone else). Read-only display + Copy + Regen.
        (u.id && Number(u.id) === Number(CRM.user.id)) ? h('div', { class: 'f-row full' },
          h('label', {}, 'Calendly webhook URL'),
          h('p', { class: 'muted', style: { margin: '0 0 .4rem', fontSize: '.78rem' } },
            'Paste this into Calendly → Account → Integrations & apps → Webhooks → "+ Webhook" → URL. Subscribe to ',
            h('code', {}, 'invitee.created'), ' and ', h('code', {}, 'invitee.canceled'),
            '. Every booking will then auto-create a follow-up + remark on the matching lead.'),
          h('div', { id: 'calendly-webhook-row', style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
            h('input', { id: 'calendly-webhook-input', type: 'text', value: 'Loading…', readonly: 'readonly', style: { flex: 1, fontFamily: 'monospace', fontSize: '.82rem' } }),
            h('button', { type: 'button', class: 'btn sm', onclick: async () => {
              const inp = $('#calendly-webhook-input');
              try { await navigator.clipboard.writeText(inp.value); toast('Copied'); }
              catch (_) { inp.select(); document.execCommand('copy'); toast('Copied'); }
            } }, '📋 Copy'),
            h('button', { type: 'button', class: 'btn sm danger', onclick: async () => {
              if (!await confirmDialog('Generate a new webhook URL? The old one will stop working — you\'ll need to update it in Calendly.')) return;
              try {
                const r = await api('api_users_regenerateCalendlyWebhook');
                const url = location.origin + '/hook/calendly/' + r.token;
                $('#calendly-webhook-input').value = url;
                toast('New URL generated — paste it back into Calendly');
              } catch (e) { toast(e.message, 'err'); }
            } }, '↻ Regenerate')
          )
        ) : null,

        // Personal
        section('👤 Personal'),
        field('father_name', 'Father\'s name', u.father_name),
        field('personal_email', 'Personal email', u.personal_email, { type: 'email' }),
        h('div', { class: 'f-row full' },
          h('label', {}, 'Address'),
          h('textarea', { name: 'address', rows: 2 }, u.address || '')
        ),
        field('aadhaar_number', 'Aadhaar number', u.aadhaar_number),
        field('pan_number', 'PAN number', u.pan_number),

        // Emergency contact
        section('🚨 Emergency contact'),
        field('emergency_contact_name', 'Name', u.emergency_contact_name),
        field('emergency_contact_phone', 'Phone', u.emergency_contact_phone),

        // References
        section('📞 Reference 1'),
        field('reference_1_name', 'Name', u.reference_1_name),
        field('reference_1_phone', 'Phone', u.reference_1_phone),
        field('reference_1_relation', 'Relation / Position', u.reference_1_relation),

        section('📞 Reference 2'),
        field('reference_2_name', 'Name', u.reference_2_name),
        field('reference_2_phone', 'Phone', u.reference_2_phone),
        field('reference_2_relation', 'Relation / Position', u.reference_2_relation),

        // Bank — separate UI under Bank tab once user is saved
        u.id ? section('🏦 Bank details') : null,
        u.id ? h('div', { class: 'f-row full' },
          h('p', { class: 'muted', style: { margin: 0, fontSize: '.85rem' } },
            'Bank details for this user are managed separately under the ',
            h('a', { href: '#/bank', onclick: () => modal.remove() }, 'Bank tab'),
            '. Admins can view all employees\' bank details there.')
        ) : null
      ),
      passwordResetBlock,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const f = $('#u-form');
          const fd = new FormData(f);
          const payload = {
            id: u.id,
            name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'),
            role: fd.get('role'), parent_id: fd.get('parent_id') || null,
            department: fd.get('department'), designation: fd.get('designation'),
            joining_date: fd.get('joining_date') || '',
            monthly_salary: Number(fd.get('monthly_salary')) || 0,
            // HR / onboarding
            father_name:             fd.get('father_name')             || '',
            personal_email:          fd.get('personal_email')          || '',
            address:                 fd.get('address')                 || '',
            aadhaar_number:          fd.get('aadhaar_number')          || '',
            pan_number:              fd.get('pan_number')              || '',
            last_company:            fd.get('last_company')            || '',
            emergency_contact_name:  fd.get('emergency_contact_name')  || '',
            emergency_contact_phone: fd.get('emergency_contact_phone') || '',
            reference_1_name:        fd.get('reference_1_name')        || '',
            reference_1_phone:       fd.get('reference_1_phone')       || '',
            reference_1_relation:    fd.get('reference_1_relation')    || '',
            reference_2_name:        fd.get('reference_2_name')        || '',
            reference_2_phone:       fd.get('reference_2_phone')       || '',
            reference_2_relation:    fd.get('reference_2_relation')    || '',
            daily_lead_cap:          Number(fd.get('daily_lead_cap'))   || 0,
            monthly_lead_cap:        Number(fd.get('monthly_lead_cap')) || 0,
            calendly_url:            fd.get('calendly_url')            || '',
            autodial_on:             fd.get('autodial_on') ? 1 : 0
          };
          if (!u.id) payload.password = fd.get('password');
          try { await api('api_users_save', payload); toast('Saved'); modal.remove(); await warmCache(); navigateTo('users'); }
          catch (e) { toast(e.message, 'err'); }
        } }, 'Save')
      )
    )
  );
  document.body.appendChild(modal);
  // Fetch and render the Calendly webhook URL (only shown when editing
  // your own profile — see #calendly-webhook-input above).
  if (u.id && Number(u.id) === Number(CRM.user.id)) {
    api('api_users_calendlyWebhook').then(r => {
      const inp = document.getElementById('calendly-webhook-input');
      if (inp) inp.value = location.origin + '/hook/calendly/' + r.token;
    }).catch(() => {});
  }
}

/**
 * Password reset section inside the user edit modal. Lets an admin (or
 * manager-of-this-user) set a custom password OR generate a random one,
 * apply it, and copy the plaintext to share with the employee.
 *
 * Only the bcrypt hash is stored on the server. The plaintext shown here is
 * the one moment it's available — the admin should copy it and send it to
 * the user via WhatsApp / email immediately.
 */
function buildPasswordResetBlock(u) {
  const me = CRM.user || {};
  // Hide for users who can't reset others — keeps the UI clean for non-admins.
  if (!['admin', 'manager'].includes(me.role)) return null;

  const wrap = h('div', { class: 'pwd-reset-block' });
  wrap.appendChild(h('h4', {}, '🔑 Reset password'));
  wrap.appendChild(h('p', { class: 'muted', style: { fontSize: '.85rem' } },
    'Set a new password for ', h('b', {}, u.name),
    '. Leave the field empty and click Generate to auto-create a strong one.'));

  const input = h('input', {
    type: 'text', name: 'pwd_new',
    placeholder: 'Type a new password (min 6 chars), or click Generate',
    autocomplete: 'new-password',
    style: { fontFamily: 'monospace' }
  });

  const result = h('div', { class: 'pwd-reset-result', hidden: 'hidden' });

  const generateBtn = h('button', { type: 'button', class: 'btn', onclick: () => {
    input.value = generateTempPasswordClient();
    input.focus();
    input.select();
  } }, '🎲 Generate');

  const applyBtn = h('button', { type: 'button', class: 'btn warn', onclick: async () => {
    const proposed = String(input.value || '').trim();
    if (proposed && proposed.length < 6) {
      toast('Password must be at least 6 characters (or leave it empty to auto-generate).', 'err');
      return;
    }
    if (!await confirmDialog(
      `Reset password for ${u.name}?\n\nThis will not log them out of existing sessions, but their old password will stop working. Make sure to share the new one with them.`
    )) return;
    applyBtn.disabled = 'disabled';
    applyBtn.textContent = 'Resetting…';
    try {
      const out = await api('api_users_resetPassword', u.id, proposed);
      // Show the new password — this is the only chance to see it.
      result.innerHTML = '';
      const pwdSpan = h('code', { class: 'pwd-reveal' }, out.password);
      result.appendChild(h('div', { class: 'pwd-reveal-row' },
        h('span', { class: 'muted', style: { marginRight: '.5rem' } }, '✅ New password:'),
        pwdSpan,
        h('button', { type: 'button', class: 'btn sm ghost', onclick: () => {
          navigator.clipboard.writeText(out.password).then(
            () => toast('Copied to clipboard'),
            () => toast('Copy failed — select and copy manually.', 'err')
          );
        } }, '📋 Copy')
      ));
      result.appendChild(h('p', { class: 'muted', style: { fontSize: '.8rem', marginTop: '.5rem' } },
        '⚠️ This password is shown only once. Send it to ', h('b', {}, u.name),
        ' now (WhatsApp / email). Closing this modal will not be able to recover it.'
      ));
      result.hidden = null;
      input.value = '';
      toast('Password reset for ' + u.name);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      applyBtn.disabled = null;
      applyBtn.textContent = 'Apply reset';
    }
  } }, 'Apply reset');

  wrap.appendChild(h('div', { class: 'pwd-reset-row' }, input, generateBtn, applyBtn));
  wrap.appendChild(result);
  return wrap;
}

/**
 * Client-side password generator — same character set as the server's
 * _generateTempPassword. Used only for previewing in the input; the server
 * generates its own when the field is left empty.
 */
function generateTempPasswordClient() {
  const upper  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower  = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const punct  = '@#$%&*';
  const all = upper + lower + digits + punct;
  const pick = (set) => set[Math.floor(Math.random() * set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(punct)];
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/* ---------------- HR views ---------------- */
VIEWS.tasks = async (view) => {
  view.innerHTML = '';
  // Two-tab view: All tasks + Done today
  const tabs = h('div', { class: 'subtabs' },
    h('button', { class: 'subtab active', onclick: ev => switchTab(ev, 'all') }, 'All tasks'),
    h('button', { class: 'subtab', onclick: ev => switchTab(ev, 'today') }, "✅ What I did today")
  );
  const content = h('div', { id: 'task-content' });
  view.append(tabs, content);
  renderAllTasks();

  function switchTab(ev, which) {
    $$('.subtab', tabs).forEach(b => b.classList.remove('active'));
    ev.target.classList.add('active');
    if (which === 'all')   renderAllTasks();
    if (which === 'today') renderTodayTasks();
  }

  async function renderAllTasks() {
    content.innerHTML = '<div class="loading">Loading…</div>';
    const rows = await api('api_tasks_list', {});
    content.innerHTML = '';
    content.append(
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => openTaskModal() }, '+ New task')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Assigned'), h('th', {}, 'Due'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, ...rows.map(t => h('tr', {},
          h('td', {}, t.title), h('td', {}, t.assigned_name || ''),
          h('td', {}, fmtDate(t.due_at)), h('td', {}, t.status),
          h('td', {}, t.status !== 'done' ? h('button', { class: 'btn sm', onclick: async () => { await api('api_tasks_complete', t.id); toast('Done'); renderAllTasks(); } }, '✓') : null)
        )))
      ))
    );
  }

  async function renderTodayTasks() {
    content.innerHTML = '<div class="loading">Loading…</div>';
    const d = await api('api_tasks_doneToday');
    content.innerHTML = '';
    content.append(
      h('div', { class: 'cards' },
        h('div', { class: 'card stat ok' },
          h('div', { class: 'stat-icon' }, '✅'),
          h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Tasks done today'),
            h('div', { class: 'stat-value' }, d.totals.my_tasks))),
        h('div', { class: 'card stat accent' },
          h('div', { class: 'stat-icon' }, '🔔'),
          h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Follow-ups done today'),
            h('div', { class: 'stat-value' }, d.totals.my_followups))),
        d.totals.team_tasks > 0 ? h('div', { class: 'card stat' },
          h('div', { class: 'stat-icon' }, '👥'),
          h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Team tasks today'),
            h('div', { class: 'stat-value' }, d.totals.team_tasks))) : null
      ),
      h('div', { class: 'card' },
        h('h3', {}, '🎯 My completed tasks'),
        d.my_tasks_done.length === 0
          ? h('p', { class: 'muted' }, 'Nothing ticked off yet today — let\'s get to it!')
          : h('ul', { class: 'done-list' },
              ...d.my_tasks_done.map(t => h('li', {},
                h('span', { class: 'check' }, '✓'),
                h('div', { class: 'done-body' },
                  h('div', { class: 'done-title' }, t.title),
                  t.description ? h('div', { class: 'muted' }, t.description) : null
                ),
                h('span', { class: 'done-time muted' }, t.completed_at_label)
              ))
            )
      ),
      d.my_followups_done.length > 0 ? h('div', { class: 'card' },
        h('h3', {}, '🔔 Follow-ups closed today'),
        h('ul', { class: 'done-list' }, ...d.my_followups_done.map(f => h('li', {},
          h('span', { class: 'check' }, '✓'),
          h('div', { class: 'done-body' },
            h('div', { class: 'done-title' }, 'Follow-up #' + f.id),
            f.note ? h('div', { class: 'muted' }, f.note) : null)
        )))
      ) : null,
      d.team_done && d.team_done.length > 0 ? h('div', { class: 'card' },
        h('h3', {}, '👥 Team activity today'),
        ...d.team_done.map(g => h('div', { class: 'team-group' },
          h('h4', {}, g.user_name, ' ', h('small', { class: 'muted' }, g.user_role, ' — ', g.count, ' done')),
          h('ul', { class: 'done-list' }, ...g.tasks.map(t => h('li', {},
            h('span', { class: 'check' }, '✓'), h('div', { class: 'done-body' }, h('div', { class: 'done-title' }, t.title))
          )))
        ))
      ) : null
    );
  }
};
async function openTaskModal() {
  const users = CRM.cache.users || await api('api_users_list');
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h3', {}, 'New task'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
    h('form', { id: 't-form', class: 'form-grid' },
      field('title', 'Title *', '', { required: true }),
      field('description', 'Description', '', { type: 'textarea', full: true }),
      selectField('assigned_to', 'Assign to', CRM.user.id, users.map(u => ({ value: u.id, label: u.name }))),
      field('due_at', 'Due', '', { type: 'datetime-local' })
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const f = $('#t-form');
        try { await api('api_tasks_save', { title: f.title.value, description: f.description.value, assigned_to: Number(f.assigned_to.value), due_at: localDtInputToIso(f.due_at.value) }); toast('Created'); modal.remove(); navigateTo('tasks'); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Create')
    )
  ));
  document.body.appendChild(modal);
}

VIEWS.attendance = async (view) => {
  view.innerHTML = '';
  const canReport = ['admin', 'manager', 'team_leader'].includes(CRM.user.role);
  const tabs = [{ id: 'mine', label: 'My attendance' }];
  if (canReport) {
    tabs.push({ id: 'report',   label: 'Team report (matrix)' });
    tabs.push({ id: 'detailed', label: '📋 Detailed log' });
    tabs.push({ id: 'trail',    label: '🗺️ Location trail' });
  }
  const nav = h('div', { class: 'subtabs' },
    ...tabs.map(t => h('button', { class: 'subtab' + (t.id === 'mine' ? ' active' : ''),
      onclick: ev => showAttTab(ev, t.id) }, t.label))
  );
  view.append(nav, h('div', { id: 'att-body' }));
  showAttTab(null, 'mine');
};
async function showAttTab(ev, id) {
  if (ev) { $$('.subtab').forEach(b => b.classList.remove('active')); ev.target.classList.add('active'); }
  const body = $('#att-body');
  body.innerHTML = '<div class="loading">…</div>';
  if (id === 'mine')     body.replaceChildren(await renderMyAttendance());
  if (id === 'report')   body.replaceChildren(await renderAttendanceReport());
  if (id === 'detailed') body.replaceChildren(await renderAttendanceDetailed());
  if (id === 'trail')    body.replaceChildren(await renderLocationTrail());
}

/* ---------------- Location trail view (admin / manager) ----------------
 * Pick a user + a date → see their 30-min location pings on a Leaflet map
 * with a polyline connecting them. Includes the check-in pin (green) and
 * check-out pin (red) for context.
 * --------------------------------------------------------------------- */
async function renderLocationTrail() {
  await ensureLeaflet();
  const wrap = h('div', {});
  const users = (CRM.cache.users || []).filter(u => Number(u.is_active) === 1);
  const today = new Date().toISOString().slice(0, 10);

  const userSel = h('select', { id: 'lt-user' },
    h('option', { value: '' }, '— Pick employee —'),
    ...users.map(u => h('option', { value: u.id }, u.name))
  );
  const dateInp = h('input', { type: 'date', id: 'lt-date', value: today });
  const summary = h('div', { id: 'lt-summary', class: 'muted', style: { marginTop: '.5rem' } });
  const mapBox = h('div', { id: 'lt-map', style: { height: '480px', borderRadius: '12px', marginTop: '.75rem', background: '#f1f5f9' } });

  async function load() {
    const uid = userSel.value; const date = dateInp.value;
    summary.textContent = '';
    mapBox.innerHTML = '';
    if (!uid) { summary.textContent = 'Pick an employee to load their trail.'; return; }
    let resp;
    try { resp = await api('api_location_trail', uid, date); }
    catch (e) { summary.textContent = 'Could not load: ' + e.message; return; }
    const att = resp && resp.attendance;
    const pings = (resp && resp.pings) || [];
    if (!att) { summary.textContent = 'No attendance record for this date.'; return; }

    const wmLabel = { office: '🏢 Office', home: '🏠 Home', on_site: '📍 On-site' }[att.work_mode] || '—';
    summary.innerHTML = '';
    summary.appendChild(h('div', {},
      h('b', {}, 'Mode: '), wmLabel, ' · ',
      h('b', {}, 'Check-in: '), att.check_in ? fmtDate(att.check_in) : '—',
      att.check_out ? h('span', {}, ' · ', h('b', {}, 'Check-out: '), fmtDate(att.check_out)) : null,
      ' · ', h('b', {}, 'Pings: '), pings.length
    ));

    setTimeout(() => {
      const map = L.map('lt-map');
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 19
      }).addTo(map);
      const pts = [];
      // Check-in pin (green)
      if (att.check_in_lat && att.check_in_lng) {
        const c = [Number(att.check_in_lat), Number(att.check_in_lng)];
        L.circleMarker(c, { radius: 10, color: '#10b981', fillColor: '#10b981', fillOpacity: 0.9 })
          .addTo(map).bindPopup('🕘 <b>Check in</b><br>' + fmtDate(att.check_in)
            + (att.check_in_location_name ? '<br>📍 ' + esc(att.check_in_location_name) : ''));
        pts.push(c);
      }
      // Pings (blue dots) connected by a polyline
      const pingPts = pings
        .filter(p => p.lat && p.lng)
        .map(p => [Number(p.lat), Number(p.lng)]);
      pings.forEach((p, i) => {
        if (!p.lat || !p.lng) return;
        const c = [Number(p.lat), Number(p.lng)];
        L.circleMarker(c, { radius: 6, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.7 })
          .addTo(map).bindPopup(
            '#' + (i + 1) + ' · ' + fmtDate(p.created_at, 'relative')
            + (p.location_name ? '<br>📍 ' + esc(p.location_name) : '')
            + (p.accuracy_m ? '<br>Accuracy: ±' + Math.round(p.accuracy_m) + ' m' : '')
          );
        pts.push(c);
      });
      if (pingPts.length > 1) {
        L.polyline(pingPts, { color: '#3b82f6', weight: 2, opacity: 0.6, dashArray: '4 4' }).addTo(map);
      }
      // Check-out pin (red)
      if (att.check_out_lat && att.check_out_lng) {
        const c = [Number(att.check_out_lat), Number(att.check_out_lng)];
        L.circleMarker(c, { radius: 10, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.9 })
          .addTo(map).bindPopup('🕔 <b>Check out</b><br>' + fmtDate(att.check_out)
            + (att.check_out_location_name ? '<br>📍 ' + esc(att.check_out_location_name) : ''));
        pts.push(c);
      }
      if (pts.length === 0) {
        map.setView([20, 78], 4);
      } else if (pts.length === 1) {
        map.setView(pts[0], 16);
      } else {
        map.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
      }
    }, 50);
  }

  userSel.onchange = load;
  dateInp.onchange = load;

  wrap.append(
    h('div', { class: 'toolbar' },
      h('label', {}, 'Employee'), userSel,
      h('label', {}, 'Date'), dateInp,
      h('button', { class: 'btn primary', onclick: load }, 'Load trail')
    ),
    summary,
    mapBox
  );
  return wrap;
}

/**
 * Detailed attendance log — flat table with one row per check-in. Shows
 * every detail captured when the employee punched in/out: exact time,
 * GPS map link, device info, status. Filterable by date range and user.
 *
 * Uses api_attendance_team which already returns the flat rows scoped to
 * what the caller can see (admin → everyone; manager / team_leader →
 * their team only).
 */
async function renderAttendanceDetailed() {
  const wrap = h('div', {});
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const fromInp = h('input', { type: 'date', value: monthAgo });
  const toInp   = h('input', { type: 'date', value: today });
  const users = CRM.cache.users || [];
  const userSel = h('select', {},
    h('option', { value: '' }, 'All users'),
    ...users.map(u => h('option', { value: u.id }, u.name))
  );
  const out = h('div', { id: 'att-detail-out' });

  async function load() {
    out.innerHTML = '<div class="loading">…</div>';
    try {
      const rows = await api('api_attendance_team', fromInp.value || undefined, toInp.value || undefined, userSel.value || undefined);
      out.innerHTML = '';
      if (!rows.length) {
        out.appendChild(h('p', { class: 'muted' }, 'No attendance records in this range.'));
        return;
      }
      // Build the detailed table
      out.appendChild(h('p', { class: 'muted', style: { fontSize: '.85rem' } },
        rows.length + ' check-in record(s). Click 🗺️ to see the GPS pin on a map.'));
      out.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Date'),
          h('th', {}, 'Employee'),
          h('th', {}, 'Status'),
          h('th', {}, 'Mode'),
          h('th', {}, 'Check-in'),
          h('th', {}, 'Check-out'),
          h('th', {}, 'Hours'),
          h('th', {}, 'Location'),
          h('th', {}, 'Map'),
          h('th', {}, 'Device')
        )),
        h('tbody', {}, ...rows.map(r => {
          const inT  = r.check_in  ? new Date(r.check_in).toLocaleTimeString()  : '—';
          const outT = r.check_out ? new Date(r.check_out).toLocaleTimeString() : '—';
          const hrs  = (r.check_in && r.check_out) ? ((new Date(r.check_out) - new Date(r.check_in)) / 3600000).toFixed(1) + 'h' : '—';
          const hasMap = !!(r.check_in_lat && r.check_in_lng);
          const status = r.status || 'present';
          const locName = r.check_in_location_name || '';
          // Work mode pill — colour-coded so admin can see at a glance
          // who's WFH vs in-office vs out on field
          const modeMap = {
            office:  { icon: '🏢', label: 'Office',  bg: '#dbeafe', color: '#1d4ed8' },
            home:    { icon: '🏠', label: 'Home',    bg: '#dcfce7', color: '#15803d' },
            on_site: { icon: '📍', label: 'On-site', bg: '#fef3c7', color: '#92400e' }
          };
          const mode = modeMap[r.work_mode];
          return h('tr', {},
            h('td', {}, String(r.date || '').slice(0, 10)),
            h('td', {}, h('b', {}, r.user_name || ('User #' + r.user_id))),
            h('td', {}, h('span', { class: 'tag', style: { background: status === 'present' ? '#10b981' : '#94a3b8', color: '#fff' } }, status)),
            h('td', {}, mode
              ? h('span', { class: 'tag', style: { background: mode.bg, color: mode.color, fontSize: '.72rem', fontWeight: 600 } }, mode.icon + ' ' + mode.label)
              : h('span', { class: 'muted' }, '—')
            ),
            h('td', {}, inT),
            h('td', {}, outT),
            h('td', {}, hrs),
            h('td', { style: { fontSize: '.82rem', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: locName || '' },
              locName ? h('span', {}, '📍 ', locName) : h('span', { class: 'muted' }, '—')
            ),
            h('td', {},
              hasMap ? h('button', { class: 'btn sm', onclick: () => openAttendanceMap(r), title: 'Open GPS pin' }, '🗺️') : h('span', { class: 'muted' }, '—')
            ),
            h('td', { class: 'muted', style: { fontSize: '.78rem', maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.device_info || '' },
              r.device_info || '—'
            )
          );
        }))
      )));
    } catch (e) {
      out.innerHTML = '';
      out.appendChild(h('div', { class: 'error-box' }, e.message));
    }
  }

  wrap.append(
    h('div', { class: 'toolbar' },
      h('label', {}, 'From'), fromInp,
      h('label', {}, 'To'), toInp,
      h('label', {}, 'User'), userSel,
      h('button', { class: 'btn primary', onclick: load }, 'Apply')
    ),
    out
  );
  await load();
  return wrap;
}
async function renderMyAttendance() {
  const rows = await api('api_attendance_mine');
  const card = h('div', {});
  card.append(
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => checkInOut('checkIn') }, '🕘 Check in'),
      h('button', { class: 'btn', onclick: () => checkInOut('checkOut') }, '🕔 Check out')
    ),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Date'), h('th', {}, 'In'), h('th', {}, 'Out'),
        h('th', {}, 'Location'), h('th', {}, 'Device'), h('th', {}, 'Status')
      )),
      h('tbody', {}, ...rows.map(r => h('tr', {},
        h('td', {}, r.date),
        h('td', {}, fmtDate(r.check_in, 'time')),
        h('td', {}, fmtDate(r.check_out, 'time')),
        h('td', {}, (r.check_in_lat && r.check_in_lng)
          ? h('a', { href: '#', onclick: ev => { ev.preventDefault(); openAttendanceMap(r); }, title: r.check_in_location_name || '' },
              r.check_in_location_name ? '📍 ' + r.check_in_location_name : '🗺️ Map')
          : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'muted' }, r.device_info || '—'),
        h('td', {}, r.status || '')
      )))
    ))
  );
  return card;
}
async function renderAttendanceReport() {
  const month = new Date().toISOString().slice(0, 7);
  const users = CRM.cache.users || [];
  const monthInput = h('input', { type: 'month', id: 'ar-month', value: month });
  const userSel = h('select', { id: 'ar-user' },
    h('option', { value: '' }, 'All users'),
    ...users.map(u => h('option', { value: u.id }, u.name))
  );
  const out = h('div', { id: 'ar-out' });
  const card = h('div', {},
    h('div', { class: 'toolbar' },
      h('label', {}, 'Month'), monthInput,
      h('label', {}, 'User'), userSel,
      h('button', { class: 'btn primary', onclick: load }, 'Load')
    ),
    out
  );
  await load();
  return card;

  async function load() {
    out.innerHTML = '<div class="loading">…</div>';
    try {
      const r = await api('api_attendance_report', monthInput.value, userSel.value || undefined);
      out.innerHTML = '';
      if (!r.users.length) { out.innerHTML = '<p class="muted">No users in scope.</p>'; return; }

      // Summary cards per user
      out.append(h('div', { class: 'cards' }, ...r.users.slice(0, 4).map(u => {
        const t = r.totals[u.id];
        return h('div', { class: 'card stat' },
          h('div', { class: 'stat-icon' }, '🕒'),
          h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, u.name),
            h('div', { class: 'stat-value' }, t.present + ' days'),
            h('div', { class: 'muted' }, Math.round(t.hours) + 'h worked · ' + t.absent + ' absent')
          )
        );
      })));

      // Matrix table
      const thead = h('thead', {},
        h('tr', {},
          h('th', {}, 'User'),
          ...r.dates.map(d => h('th', { class: 'day-col', title: d }, d.slice(-2))),
          h('th', {}, 'Present'),
          h('th', {}, 'Hours')
        )
      );
      const tbody = h('tbody', {},
        ...r.users.map(u => {
          const t = r.totals[u.id];
          return h('tr', {},
            h('td', {}, h('b', {}, u.name), h('br'), h('span', { class: 'muted' }, u.role)),
            ...r.dates.map(d => {
              const c = r.matrix[u.id][d];
              if (!c) return h('td', { class: 'day-cell absent', title: d + ' absent' }, '');
              const hours = c.hours ? c.hours.toFixed(1) : '';
              const title = `${d} · in ${c.in ? new Date(c.in).toLocaleTimeString() : '—'} · out ${c.out ? new Date(c.out).toLocaleTimeString() : '—'} · ${hours}h · ${c.device}`;
              return h('td', { class: 'day-cell present', title }, '✓');
            }),
            h('td', { class: 'cell-ok' }, t.present),
            h('td', {}, t.hours.toFixed(1) + 'h')
          );
        })
      );
      out.append(h('div', { class: 'table-wrap scroll-x' }, h('table', { class: 'att-matrix' }, thead, tbody)));
    } catch (e) { out.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  }
}

async function ensureLeaflet() {
  if (window.L) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.crossOrigin = '';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function openAttendanceMap(r) {
  await ensureLeaflet();
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } },
    h('div', { class: 'modal modal-lg' },
      h('div', { class: 'modal-head' }, h('h3', {}, `🗺️ ${r.date} — attendance trail`), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      h('div', { id: 'att-map', style: { height: '400px', borderRadius: '8px' } }),
      h('div', { class: 'att-meta' },
        r.device_info ? h('div', {}, h('b', {}, 'Device: '), r.device_info) : null,
        r.user_agent ? h('div', { class: 'muted' }, h('b', {}, 'UA: '), r.user_agent) : null,
        h('div', {}, h('b', {}, 'Check in: '), fmtDate(r.check_in),
          r.check_in_location_name ? h('span', {}, '  ·  📍 ', h('b', {}, r.check_in_location_name)) : null,
          '  ·  ',
          r.check_in_lat ? h('span', { class: 'muted', style: { fontSize: '.78rem' } }, `${Number(r.check_in_lat).toFixed(5)}, ${Number(r.check_in_lng).toFixed(5)}`) : '—'),
        r.check_out ? h('div', {}, h('b', {}, 'Check out: '), fmtDate(r.check_out),
          r.check_out_location_name ? h('span', {}, '  ·  📍 ', h('b', {}, r.check_out_location_name)) : null,
          '  ·  ',
          r.check_out_lat ? h('span', { class: 'muted', style: { fontSize: '.78rem' } }, `${Number(r.check_out_lat).toFixed(5)}, ${Number(r.check_out_lng).toFixed(5)}`) : '—') : null
      )
    )
  );
  document.body.appendChild(modal);
  setTimeout(() => {
    const map = L.map('att-map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 19
    }).addTo(map);
    const pts = [];
    if (r.check_in_lat && r.check_in_lng) {
      const c = [Number(r.check_in_lat), Number(r.check_in_lng)];
      const inHtml = '🕘 <b>Check in</b><br>' + fmtDate(r.check_in)
        + (r.check_in_location_name ? '<br>📍 ' + esc(r.check_in_location_name) : '');
      L.marker(c).addTo(map).bindPopup(inHtml);
      pts.push(c);
    }
    if (r.check_out_lat && r.check_out_lng) {
      const c = [Number(r.check_out_lat), Number(r.check_out_lng)];
      const outHtml = '🕔 <b>Check out</b><br>' + fmtDate(r.check_out)
        + (r.check_out_location_name ? '<br>📍 ' + esc(r.check_out_location_name) : '');
      L.marker(c).addTo(map).bindPopup(outHtml);
      pts.push(c);
    }
    if (pts.length === 2) L.polyline(pts, { color: '#6366f1', weight: 3 }).addTo(map);
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    else map.setView([20, 78], 4);
  }, 50);
}

/**
 * Reverse-geocode a (lat, lng) pair to a human-readable address.
 *
 * Uses BigDataCloud's free reverse-geocode endpoint — no API key required,
 * CORS-allowed, 50k req/day free, and returns a useful Indian-locality
 * breakdown (city, locality, principalSubdivision) which we collapse to a
 * single readable string. Falls back to null on any error so the check-in
 * flow never blocks on a network hiccup.
 */
async function _reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return null;
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
  try {
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) return null;
    const j = await resp.json();
    // Prefer the most-specific locality bits, joined with commas.
    // Example output: "Sector 18, Noida, Uttar Pradesh, India"
    const parts = [
      j.locality, j.city, j.principalSubdivision, j.countryName
    ].map(s => (s || '').trim()).filter(Boolean);
    // Dedupe consecutive duplicates (BDC sometimes returns city = locality)
    const dedup = parts.filter((p, i) => i === 0 || p !== parts[i - 1]);
    return dedup.length ? dedup.join(', ') : null;
  } catch (_) { return null; }
}

/**
 * Show a quick "where are you working from?" picker before check-in fires.
 * Three options matching the schema: office | home | on_site. Pre-selects
 * office (the default for most teams). Returns a Promise that resolves to
 * the chosen mode or null if the user closed the picker.
 */
function _pickWorkMode() {
  return new Promise(resolve => {
    let resolved = false;
    const finish = (val) => { if (!resolved) { resolved = true; m.remove(); resolve(val); } };
    const opt = (mode, icon, label, blurb) =>
      h('button', {
        class: 'wm-opt', 'data-mode': mode,
        onclick: () => finish(mode),
        style: { display: 'flex', alignItems: 'center', gap: '.65rem', padding: '.85rem 1rem', width: '100%', textAlign: 'left', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px', cursor: 'pointer', marginBottom: '.5rem' }
      },
        h('span', { style: { fontSize: '1.6rem' } }, icon),
        h('div', {},
          h('div', { style: { fontWeight: 600 } }, label),
          h('div', { class: 'muted', style: { fontSize: '.78rem' } }, blurb)
        )
      );
    const m = h('div', { class: 'modal-backdrop',
      onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) finish(null); }
    },
      h('div', { class: 'modal' },
        h('div', { class: 'modal-head' },
          h('h3', {}, '🕘 Where are you working from?'),
          h('button', { class: 'btn icon', onclick: () => finish(null) }, '✕')
        ),
        h('div', { class: 'modal-body' },
          opt('office',  '🏢', 'Office',          'In the office today.'),
          opt('home',    '🏠', 'Work from home',  'Working remotely.'),
          opt('on_site', '📍', 'On-site / Field', 'Customer visit, project site, etc.')
        )
      )
    );
    document.body.appendChild(m);
  });
}

async function checkInOut(which) {
  const device = _collectDevice();
  // Ask work mode for check-in only (check-out doesn't need it)
  let workMode = null;
  if (which === 'checkIn') {
    workMode = await _pickWorkMode();
    if (!workMode) return;  // user cancelled
  }
  const call = async (lat, lng) => {
    // Reverse-geocode in parallel with the API call so check-in stays fast
    // even on a flaky network. If the geocode fails, we still check in
    // with just the coordinates.
    let locationName = null;
    if (lat != null && lng != null) {
      try { locationName = await _reverseGeocode(lat, lng); } catch (_) {}
    }
    try {
      await api('api_attendance_' + which, lat, lng, device, locationName, workMode);
      toast(which === 'checkIn'
        ? ('Checked in · ' + (workMode === 'home' ? '🏠 Home' : workMode === 'on_site' ? '📍 On-site' : '🏢 Office'))
        : 'Checked out');
      // Start / stop the 30-minute location-ping timer
      if (which === 'checkIn') startLocationPingTimer();
      else stopLocationPingTimer();
      navigateTo('attendance');
    }
    catch (e) { toast(e.message, 'err'); }
  };
  if (!navigator.geolocation) return call(null, null);
  navigator.geolocation.getCurrentPosition(
    p => call(p.coords.latitude, p.coords.longitude),
    () => call(null, null)
  );
}

/* ---------------- 30-minute location-ping loop --------------------------
 * While the user is checked in (no check_out yet for today), ping their
 * location every 30 minutes and post to the server. Runs only while the
 * app/tab is open — Android's background-kill rules + browser background
 * geolocation restrictions make true background tracking unreliable
 * (same constraints we hit with call detection). Documented limitation.
 * --------------------------------------------------------------------- */

let _locPingTimer = null;
const PING_INTERVAL_MS = 30 * 60 * 1000;

function startLocationPingTimer() {
  if (_locPingTimer) clearInterval(_locPingTimer);
  // First ping right away so the trail starts at check-in
  setTimeout(() => _sendLocationPing().catch(() => {}), 5000);
  _locPingTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    _sendLocationPing().catch(() => {});
  }, PING_INTERVAL_MS);
  console.log('[locping] timer started, interval=' + PING_INTERVAL_MS + 'ms');
}

function stopLocationPingTimer() {
  if (_locPingTimer) clearInterval(_locPingTimer);
  _locPingTimer = null;
  console.log('[locping] timer stopped');
}

async function _sendLocationPing() {
  if (!navigator.geolocation) return;
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(async pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = pos.coords.accuracy;
      let name = null;
      try { name = await _reverseGeocode(lat, lng); } catch (_) {}
      try {
        await api('api_location_ping', lat, lng, name, acc);
        console.log('[locping] sent', { lat, lng, name, accuracy: acc });
      } catch (e) {
        console.warn('[locping] send failed:', e.message);
      }
      resolve();
    }, err => {
      console.warn('[locping] geolocation error:', err.message);
      resolve();
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 });
  });
}

// On boot, if the user is already checked in (came back to the app after
// closing it earlier in the day), restart the ping timer so the trail
// continues from where it left off.
async function _resumeLocationPingsIfCheckedIn() {
  try {
    const rows = await api('api_attendance_mine', '', '');
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = (rows || []).find(r => String(r.date).slice(0, 10) === today);
    if (todayRow && todayRow.check_in && !todayRow.check_out) {
      startLocationPingTimer();
    }
  } catch (_) {}
}

function _collectDevice() {
  const ua = navigator.userAgent || '';
  const uad = navigator.userAgentData || {};
  // Try to parse a friendly summary
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const osMatch = ua.match(/Windows NT [\d.]+|Mac OS X [\d_.]+|Android [\d.]+|iPhone OS [\d_]+|iPad; CPU OS [\d_]+|Linux/);
  const browserMatch = ua.match(/(Edg|Chrome|Safari|Firefox|OPR)\/([\d.]+)/);
  const modelMatch = ua.match(/;\s*([A-Z][\w\-]+ [\w\-]+(?: [\w\-]+)?)[);]/i) || ua.match(/\(Linux; Android [\d.]+; ([^)]+)\)/);
  const os      = osMatch ? osMatch[0].replace(/_/g, '.') : 'unknown';
  const browser = browserMatch ? browserMatch[1] + ' ' + browserMatch[2] : 'unknown';
  const model   = modelMatch ? modelMatch[1] : (uad.mobile ? 'mobile' : 'desktop');
  const summary = [isMobile ? '📱' : '💻', model, '·', os, '·', browser,
    screen.width + '×' + screen.height].join(' ').trim();
  return { summary, user_agent: ua };
}

VIEWS.leaves = async (view) => {
  view.innerHTML = '';
  const isApprover = ['admin', 'manager', 'team_leader'].includes(CRM.user.role);
  const isAdmin = CRM.user.role === 'admin';

  // Tabs: My leaves (everyone), Pending approvals (managers+), All leaves (admin only)
  const tabs = [{ id: 'mine', label: 'My leaves' }];
  if (isApprover) tabs.push({ id: 'pending', label: '⏳ Pending approvals' });
  if (isAdmin)    tabs.push({ id: 'all',     label: 'All leaves' });

  const subtabs = h('div', { class: 'subtabs' },
    ...tabs.map(t => h('button', { class: 'subtab' + (t.id === 'mine' ? ' active' : ''), 'data-leavetab': t.id,
      onclick: ev => showLeaveTab(ev, t.id) }, t.label))
  );
  view.append(subtabs, h('div', { id: 'leave-body' }));
  await showLeaveTab(null, 'mine');
};

async function showLeaveTab(ev, id) {
  if (ev) {
    document.querySelectorAll('.subtab').forEach(b => b.classList.remove('active'));
    ev.target.classList.add('active');
  }
  const body = document.getElementById('leave-body');
  body.innerHTML = '<div class="loading">Loading…</div>';
  if (id === 'mine')    body.replaceChildren(await renderMyLeaves());
  if (id === 'pending') body.replaceChildren(await renderPendingLeaves());
  if (id === 'all')     body.replaceChildren(await renderAllLeaves());
}

async function renderMyLeaves() {
  const rows = await api('api_leaves_mine').catch(() => []);
  const wrap = h('div', {});
  wrap.appendChild(h('div', { class: 'toolbar' },
    h('button', { class: 'btn primary', onclick: openLeaveModal }, '+ Apply for leave')
  ));
  if (!rows.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No leave applications yet. Click "+ Apply for leave" to submit one.'));
    return wrap;
  }
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'From'), h('th', {}, 'To'), h('th', {}, 'Reason'),
      h('th', {}, 'Status'), h('th', {}, 'Decided by')
    )),
    h('tbody', {}, ...rows.map(l => h('tr', {},
      h('td', {}, l.from_date),
      h('td', {}, l.to_date),
      h('td', {}, l.reason || '—'),
      h('td', {}, leaveStatusPill(l.status)),
      h('td', { class: 'muted' }, l.approver_name || '—')
    )))
  )));
  return wrap;
}

async function renderPendingLeaves() {
  const rows = await api('api_leaves_pending').catch(() => []);
  const wrap = h('div', {});
  if (!rows.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No leave requests waiting on you. 🎉'));
    return wrap;
  }
  wrap.appendChild(h('p', { class: 'muted', style: { marginBottom: '.75rem' } },
    rows.length + ' request' + (rows.length === 1 ? '' : 's') + ' waiting for your decision'));
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Employee'), h('th', {}, 'From'), h('th', {}, 'To'),
      h('th', {}, 'Reason'), h('th', {}, 'Applied'), h('th', {}, 'Decision')
    )),
    h('tbody', {}, ...rows.map(l => h('tr', {},
      h('td', {}, h('b', {}, l.user_name || ('User #' + l.user_id))),
      h('td', {}, l.from_date),
      h('td', {}, l.to_date),
      h('td', {}, l.reason || '—'),
      h('td', { class: 'muted' }, fmtDate(l.created_at, 'relative')),
      h('td', {},
        h('button', { class: 'btn sm', style: { background: '#10b981', color: '#fff', marginRight: '.25rem' },
          onclick: () => decideLeave(l.id, 'approved') }, '✓ Approve'),
        h('button', { class: 'btn sm', style: { background: '#ef4444', color: '#fff' },
          onclick: () => decideLeave(l.id, 'rejected') }, '✕ Reject')
      )
    )))
  )));
  return wrap;
}

async function renderAllLeaves() {
  const rows = await api('api_leaves_all').catch(() => []);
  const wrap = h('div', {});
  wrap.appendChild(h('p', { class: 'muted', style: { marginBottom: '.75rem' } },
    'Admin view — every leave application across the org, including ones outside your direct hierarchy.'));
  if (!rows.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No leave applications yet.'));
    return wrap;
  }
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Employee'), h('th', {}, 'From'), h('th', {}, 'To'),
      h('th', {}, 'Reason'), h('th', {}, 'Status'),
      h('th', {}, 'Decided by'), h('th', {}, 'Applied'), h('th', {}, '')
    )),
    h('tbody', {}, ...rows.map(l => h('tr', {},
      h('td', {}, l.user_name || ('User #' + l.user_id)),
      h('td', {}, l.from_date),
      h('td', {}, l.to_date),
      h('td', {}, l.reason || '—'),
      h('td', {}, leaveStatusPill(l.status)),
      h('td', { class: 'muted' }, l.approver_name || '—'),
      h('td', { class: 'muted' }, fmtDate(l.created_at, 'relative')),
      h('td', {}, l.status === 'pending'
        ? h('span', {},
            h('button', { class: 'btn sm', style: { background: '#10b981', color: '#fff', marginRight: '.25rem' },
              onclick: () => decideLeave(l.id, 'approved') }, '✓'),
            h('button', { class: 'btn sm', style: { background: '#ef4444', color: '#fff' },
              onclick: () => decideLeave(l.id, 'rejected') }, '✕')
          )
        : '—')
    )))
  )));
  return wrap;
}

function leaveStatusPill(status) {
  const map = { pending: '#f59e0b', approved: '#10b981', rejected: '#ef4444' };
  const c = map[String(status)] || '#94a3b8';
  return h('span', { class: 'tag', style: { background: c, color: '#fff' } }, status);
}

async function decideLeave(id, decision) {
  if (!confirm(`Are you sure you want to mark this leave as "${decision}"?`)) return;
  try {
    await api('api_leaves_decide', id, decision);
    toast('Leave ' + decision);
    // Re-render whichever tab is currently active
    const active = document.querySelector('.subtab.active')?.dataset?.leavetab || 'mine';
    showLeaveTab(null, active);
  } catch (e) { toast(e.message, 'err'); }
}
function openLeaveModal() {
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h3', {}, 'Apply leave'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
    h('form', { id: 'l-form', class: 'form-grid' },
      field('from_date', 'From *', '', { type: 'date', required: true }),
      field('to_date', 'To *', '', { type: 'date', required: true }),
      field('reason', 'Reason', '', { type: 'textarea', full: true })
    ),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const f = $('#l-form');
        try { await api('api_leaves_apply', { from_date: f.from_date.value, to_date: f.to_date.value, reason: f.reason.value }); toast('Applied'); modal.remove(); navigateTo('leaves'); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Apply'))
  ));
  document.body.appendChild(modal);
}

VIEWS.salary = async (view) => {
  view.innerHTML = '';
  const isAdminOrMgr = ['admin', 'manager'].includes(CRM.user.role);
  const tabs = [{ id: 'my', label: 'My salary' }];
  if (isAdminOrMgr) tabs.push({ id: 'report', label: 'Monthly report' });
  if (CRM.user.role === 'admin') tabs.push({ id: 'bulk', label: '✎ Bulk entry' });

  const nav = h('div', { class: 'subtabs' },
    ...tabs.map(t => h('button', { class: 'subtab' + (t.id === 'my' ? ' active' : ''), 'data-tab': t.id,
      onclick: ev => showSalaryTab(ev, t.id) }, t.label))
  );
  view.append(nav, h('div', { id: 'salary-content' }));
  showSalaryTab(null, 'my');
};

async function showSalaryTab(ev, id) {
  if (ev) {
    $$('.subtab').forEach(b => b.classList.remove('active'));
    ev.target.classList.add('active');
  }
  const body = $('#salary-content');
  body.innerHTML = '<div class="loading">Loading…</div>';
  if (id === 'my')     body.replaceChildren(await renderMySalary());
  if (id === 'report') body.replaceChildren(await renderSalaryReport());
  if (id === 'bulk')   body.replaceChildren(await renderSalaryBulk());
}

async function renderMySalary() {
  const rows = await api('api_salary_mine');
  const card = h('div', {});
  if (!rows.length) {
    card.appendChild(h('p', { class: 'muted' }, 'No salary records yet.'));
    return card;
  }
  card.appendChild(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', {}, 'Base'), h('th', {}, 'Allowances'), h('th', {}, 'Deductions'), h('th', {}, 'Net'), h('th', {}))),
    h('tbody', {}, ...rows.map(s => h('tr', {},
      h('td', {}, s.month),
      h('td', {}, '₹ ' + Number(s.base).toFixed(2)),
      h('td', {}, '₹ ' + Number(s.allowances).toFixed(2)),
      h('td', {}, '₹ ' + Number(s.deductions).toFixed(2)),
      h('td', {}, '₹ ' + Number(s.net_pay).toFixed(2)),
      h('td', {}, h('button', { class: 'btn sm', onclick: () => downloadPayslip(s.id) }, '📄 Payslip'))
    )))
  )));
  return card;
}

async function downloadPayslip(id) {
  try {
    const r = await api('api_salary_payslip', id);
    const w = window.open('', '_blank');
    w.document.write(r.html);
    w.document.close();
    setTimeout(() => w.print(), 500);
  } catch (e) { toast(e.message, 'err'); }
}

async function renderSalaryReport() {
  const monthInput = h('input', { type: 'month', id: 'sal-month', value: new Date().toISOString().slice(0, 7) });
  const go = h('button', { class: 'btn primary', onclick: () => refreshSalaryReport() }, 'Load');
  const out = h('div', { id: 'sal-report' });
  const card = h('div', {}, h('div', { class: 'toolbar' }, h('label', {}, 'Month'), monthInput, go), out);
  await refreshSalaryReport();
  return card;

  async function refreshSalaryReport() {
    out.innerHTML = '<div class="loading">…</div>';
    try {
      const r = await api('api_salary_report', monthInput.value);
      out.innerHTML = '';
      if (!r.rows.length) { out.innerHTML = '<p class="muted">No salary records for this month.</p>'; return; }
      out.append(
        h('div', { class: 'cards' },
          h('div', { class: 'card stat accent' }, h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Total base'), h('div', { class: 'stat-value' }, '₹' + r.totals.base.toFixed(0)))),
          h('div', { class: 'card stat' }, h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Allowances'), h('div', { class: 'stat-value' }, '₹' + r.totals.allowances.toFixed(0)))),
          h('div', { class: 'card stat err' }, h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Deductions'), h('div', { class: 'stat-value' }, '₹' + r.totals.deductions.toFixed(0)))),
          h('div', { class: 'card stat ok' }, h('div', { class: 'stat-body' },
            h('div', { class: 'stat-label' }, 'Net payout'), h('div', { class: 'stat-value' }, '₹' + r.totals.net_pay.toFixed(0))))
        ),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Role'),
            h('th', {}, 'Base'), h('th', {}, 'Allowances'), h('th', {}, 'Deductions'), h('th', {}, 'Net'), h('th', {}))),
          h('tbody', {}, ...r.rows.map(s => h('tr', {},
            h('td', {}, s.user_name),
            h('td', {}, s.user_role),
            h('td', {}, '₹' + Number(s.base).toFixed(2)),
            h('td', {}, '₹' + Number(s.allowances).toFixed(2)),
            h('td', {}, '₹' + Number(s.deductions).toFixed(2)),
            h('td', { class: 'cell-ok' }, '₹' + Number(s.net_pay).toFixed(2)),
            h('td', {}, h('button', { class: 'btn sm', onclick: () => downloadPayslip(s.id) }, '📄'))
          )))
        ))
      );
    } catch (e) { out.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  }
}

async function renderSalaryBulk() {
  const users = await api('api_users_list');
  const month = new Date().toISOString().slice(0, 7);
  const existing = await api('api_salary_report', month);
  const exByUser = {}; existing.rows.forEach(r => { exByUser[Number(r.user_id)] = r; });

  const monthInput = h('input', { type: 'month', id: 'bulk-month', value: month });
  const card = h('div', {},
    h('div', { class: 'toolbar' },
      h('label', {}, 'Month'),
      monthInput,
      h('button', { class: 'btn', onclick: () => showSalaryTab({ target: $$('.subtab')[2] }, 'bulk') }, 'Load month')
    ),
    h('p', { class: 'muted' }, 'Enter/adjust base / allowances / deductions for each employee and click Save all.')
  );
  const tbl = h('table', { class: 'mini-table', id: 'bulk-tbl' });
  tbl.append(
    h('thead', {}, h('tr', {},
      h('th', {}, 'User'), h('th', {}, 'Role'),
      h('th', {}, 'Base (₹)'), h('th', {}, 'Allowances (₹)'), h('th', {}, 'Deductions (₹)'), h('th', {}, 'Net')
    )),
    h('tbody', {},
      ...users.map(u => {
        const ex = exByUser[Number(u.id)] || {};
        const baseIn = h('input', { type: 'number', step: '0.01', 'data-uid': u.id, 'data-f': 'base', value: ex.base || u.monthly_salary || 0, style: { width: '110px' } });
        const alIn   = h('input', { type: 'number', step: '0.01', 'data-uid': u.id, 'data-f': 'allowances', value: ex.allowances || 0, style: { width: '110px' } });
        const dedIn  = h('input', { type: 'number', step: '0.01', 'data-uid': u.id, 'data-f': 'deductions', value: ex.deductions || 0, style: { width: '110px' } });
        const net = h('td', { class: 'cell-ok', 'data-uid-net': u.id }, '₹' + (Number(ex.net_pay) || 0).toFixed(2));
        const update = () => {
          const n = Number(baseIn.value || 0) + Number(alIn.value || 0) - Number(dedIn.value || 0);
          net.textContent = '₹' + n.toFixed(2);
        };
        [baseIn, alIn, dedIn].forEach(i => i.addEventListener('input', update));
        return h('tr', {},
          h('td', {}, u.name), h('td', {}, u.role),
          h('td', {}, baseIn), h('td', {}, alIn), h('td', {}, dedIn),
          net
        );
      })
    )
  );
  card.append(tbl, h('div', { class: 'actions' },
    h('button', { class: 'btn primary', onclick: async () => {
      const rows = [];
      const m = monthInput.value;
      users.forEach(u => {
        const base = $$(`[data-uid="${u.id}"][data-f="base"]`)[0]?.value;
        const al   = $$(`[data-uid="${u.id}"][data-f="allowances"]`)[0]?.value;
        const ded  = $$(`[data-uid="${u.id}"][data-f="deductions"]`)[0]?.value;
        rows.push({ user_id: u.id, month: m, base, allowances: al, deductions: ded });
      });
      try {
        const r = await api('api_salary_bulkSave', rows);
        toast(`Saved ${r.saved} salary rows`);
      } catch (e) { toast(e.message, 'err'); }
    } }, '💾 Save all')
  ));
  return card;
}

VIEWS.bank = async (view) => {
  view.innerHTML = '';
  const isAdmin = CRM.user.role === 'admin';

  // Sub-tabs — non-admins see only "My bank". Admins also see "All employees".
  const tabs = [{ id: 'mine', label: 'My bank details' }];
  if (isAdmin) tabs.push({ id: 'all', label: '👥 All employees' });
  const nav = h('div', { class: 'subtabs' },
    ...tabs.map(t => h('button', { class: 'subtab' + (t.id === 'mine' ? ' active' : ''),
      onclick: ev => showBankTab(ev, t.id) }, t.label))
  );
  view.append(nav, h('div', { id: 'bank-body' }));
  showBankTab(null, 'mine');
};

async function showBankTab(ev, id) {
  if (ev) { $$('.subtab').forEach(b => b.classList.remove('active')); ev.target.classList.add('active'); }
  const body = $('#bank-body');
  body.innerHTML = '<div class="loading">…</div>';
  if (id === 'mine') body.replaceChildren(await renderMyBank());
  if (id === 'all')  body.replaceChildren(await renderAllBank());
}

async function renderMyBank() {
  const info = (await api('api_bank_mine')) || {};
  const form = h('form', { class: 'form-grid', onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try { await api('api_bank_save', Object.fromEntries(fd)); toast('Saved'); }
    catch (e) { toast(e.message, 'err'); }
  }},
    field('bank_name', 'Bank name', info.bank_name),
    field('account_holder', 'Account holder', info.account_holder),
    field('account_number', 'Account number', info.account_number),
    field('ifsc', 'IFSC', info.ifsc),
    field('branch', 'Branch', info.branch),
    field('upi_id', 'UPI ID', info.upi_id),
    field('notes', 'Notes', info.notes, { type: 'textarea', full: true }),
    h('div', { class: 'f-row full' }, h('button', { type: 'submit', class: 'btn primary' }, '💾 Save'))
  );
  return form;
}

async function renderAllBank() {
  const list = await api('api_bank_list').catch(e => { toast(e.message, 'err'); return []; });
  const wrap = h('div', {});
  wrap.appendChild(h('p', { class: 'muted', style: { fontSize: '.85rem' } },
    'Account numbers are masked (****last4) for safety. Click an employee to see their full record on their profile.'));
  if (!list.length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No bank details captured yet.'));
    return wrap;
  }
  wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Employee'),
      h('th', {}, 'Bank'),
      h('th', {}, 'A/c holder'),
      h('th', {}, 'Account #'),
      h('th', {}, 'IFSC'),
      h('th', {}, 'Branch'),
      h('th', {}, 'UPI'),
      h('th', {}, 'Updated')
    )),
    h('tbody', {}, ...list.map(r => h('tr', {},
      h('td', {}, h('b', {}, r.user_name || '—')),
      h('td', {}, r.bank_name || '—'),
      h('td', {}, r.account_holder || '—'),
      h('td', { style: { fontFamily: 'monospace' } }, r.account_number || '—'),
      h('td', {}, r.ifsc || '—'),
      h('td', {}, r.branch || '—'),
      h('td', {}, r.upi_id || '—'),
      h('td', { class: 'muted' }, r.updated_at ? fmtDate(r.updated_at, 'relative') : '—')
    )))
  )));
  return wrap;
}

/* ---------------- FB connect ---------------- */
// Scopes mirror the proven PHP-CRM reference. business_management is critical
// for accounts that hold pages inside a Business Manager — without it,
// /me/accounts returns nothing or only personal pages.
const FB_LOGIN_SCOPE = [
  'public_profile',
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_ads',
  'leads_retrieval',
  'ads_management',
  'ads_read',
  'business_management'
].join(',');

const FB_REQUIRED_PERMS = [
  'pages_show_list', 'leads_retrieval', 'pages_read_engagement', 'pages_manage_metadata'
];

// Track FB SDK readiness so we can preload it when the admin Facebook tab
// renders. Without this, the SDK loads only after the user clicks Connect —
// and by the time FB.login runs, Chrome has expired the user gesture and
// blocks the popup window. Result: the "Opening Facebook login…" toast fires
// but no popup ever appears. Preloading the SDK fixes this.
let _fbSdkLoading = null;
function ensureFbSdkLoaded(appId) {
  if (window.FB && typeof window.FB.login === 'function') return Promise.resolve();
  if (_fbSdkLoading) return _fbSdkLoading;
  _fbSdkLoading = new Promise((resolve, reject) => {
    if (!appId) return reject(new Error('Set Facebook Application ID first (Admin → Facebook → Application Settings)'));
    window.fbAsyncInit = function () {
      try {
        // v21.0 — required for WhatsApp Embedded Signup (Login for Business)
        FB.init({ appId, cookie: true, xfbml: false, version: 'v21.0', autoLogAppEvents: true });
        resolve();
      } catch (e) { reject(e); }
    };
    if (document.getElementById('facebook-jssdk')) return; // already in DOM, wait for fbAsyncInit
    const s = document.createElement('script');
    s.id = 'facebook-jssdk';
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('Failed to load Facebook SDK — check internet / ad-blocker.'));
    document.body.appendChild(s);
  });
  return _fbSdkLoading;
}

/**
 * Server-side OAuth flow (the new primary method).
 * Redirects the whole browser to facebook.com — no popup, no SDK, no
 * browser permission needed. Facebook redirects back to /fb/auth/callback,
 * which fetches pages, persists, and redirects back to /#/admin/fb.
 */
async function connectFacebookServerFlow() {
  toast('Redirecting to Facebook…');
  try {
    const { auth_url } = await api('api_fb_oauth_url', location.origin);
    if (!auth_url) throw new Error('No auth URL returned');
    location.href = auth_url;
  } catch (e) {
    toast(e.message || String(e), 'err');
  }
}

/**
 * Show a diagnostic of what Facebook is returning for the current connection.
 * Used when the user connects via Embedded Login but no pages appear — we
 * surface every probe (me, permissions, accounts, businesses) so it's clear
 * which tier is failing and why.
 */
async function openFbDebugModal() {
  const m = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) m.remove(); } });
  const body = h('div', { class: 'modal modal-lg' });
  body.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, '🔍 Facebook connection debug'),
    h('button', { class: 'btn icon', onclick: () => m.remove() }, '✕')
  ));
  const content = h('div', {}, h('p', { class: 'muted' }, 'Probing Facebook…'));
  body.appendChild(content);
  m.appendChild(body);
  document.body.appendChild(m);

  try {
    const r = await api('api_fb_debug');
    content.innerHTML = '';
    if (!r.connected) {
      content.appendChild(h('p', { class: 'muted' }, r.message || 'Not connected.'));
      return;
    }
    // Summary
    const liveCount = r.live_fetch?.pages_count || 0;
    content.appendChild(h('div', { class: 'card' },
      h('h4', { style: { marginTop: 0 } }, 'Summary'),
      h('p', {}, h('b', {}, 'Live page count: '), liveCount,
        liveCount === 0 ? h('span', { class: 'muted' }, ' — Facebook is not returning any pages for this connection. See probe details below.') : null
      )
    ));
    // Probe details
    const renderObj = (obj) => h('pre', { style: { background: '#0f172a', color: '#e2e8f0', padding: '.75rem', borderRadius: '6px', overflowX: 'auto', fontSize: '.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
      JSON.stringify(obj, null, 2));
    const probeKeys = Object.keys(r.probes || {});
    const probesCard = h('div', { class: 'card' });
    probesCard.appendChild(h('h4', { style: { marginTop: 0 } }, 'Live probes'));
    probeKeys.forEach(k => {
      probesCard.appendChild(h('div', { style: { marginBottom: '.75rem' } },
        h('b', {}, k),
        renderObj(r.probes[k])
      ));
    });
    content.appendChild(probesCard);
    // Last connect tiers
    if (r.last_diag) {
      content.appendChild(h('div', { class: 'card' },
        h('h4', { style: { marginTop: 0 } }, 'Last connect attempt — tier results'),
        renderObj(r.last_diag)
      ));
    }
    // Live fetch
    if (r.live_fetch) {
      content.appendChild(h('div', { class: 'card' },
        h('h4', { style: { marginTop: 0 } }, 'Live fetch (just ran)'),
        renderObj(r.live_fetch.diag)
      ));
    }
    if (liveCount === 0) {
      content.appendChild(h('div', { class: 'error-box' },
        'No pages came back. Possible fixes:',
        h('ul', {},
          h('li', {}, 'Re-run "Connect with Facebook" and during the dialog, make sure you tick the page(s) you want — the new "Login for Business" flow asks you to select assets explicitly.'),
          h('li', {}, 'Verify the connected user has Page admin role (or Business admin if the page lives in a Business Manager).'),
          h('li', {}, 'If your app is still in Development, only admins/testers/developers of the app can grant page access. Either submit for review or add yourself as a tester in Meta App Dashboard → App Roles.'),
          h('li', {}, 'As a workaround: use "Add a page manually" below — paste a Page Access Token from Graph API Explorer and you skip the OAuth flow entirely.')
        )
      ));
    }
  } catch (e) {
    content.innerHTML = '';
    content.appendChild(h('div', { class: 'error-box' }, 'Debug failed: ' + e.message));
  }
}

function connectFacebook() {
  // Hot path: SDK is already loaded — call FB.login SYNCHRONOUSLY inside the
  // click event so the browser allows the popup. Anything async here loses
  // the user gesture and Chrome will block the popup silently.
  if (window.FB && typeof window.FB.login === 'function') {
    return _fbDoLogin();
  }

  // Cold path: SDK isn't loaded yet. Tell the user, kick off the load, and
  // ask them to click again. We can't auto-retry inside the same handler
  // because the user gesture has been spent.
  toast('Loading Facebook SDK… please click Connect again in 2 seconds.', 'warn');
  api('api_fb_status').then(({ app_id }) => {
    return ensureFbSdkLoaded(app_id);
  }).then(() => {
    toast('Facebook SDK ready — click Connect with Facebook now.');
  }).catch(e => toast(e.message, 'err'));
}

function _fbDoLogin() {
  toast('Opening Facebook login…');
  FB.login(async resp => {
    if (!resp.authResponse) return toast('Login cancelled or popup blocked. Allow popups for this site and try again.', 'warn');
    // Verify the user actually granted the four permissions we need. Without
    // this the connect appears to succeed but pages fetch returns empty.
    FB.api('me/permissions', async (permResp) => {
      const granted = (permResp && permResp.data || [])
        .filter(p => p.status === 'granted')
        .map(p => p.permission);
      const missing = FB_REQUIRED_PERMS.filter(p => !granted.includes(p));
      if (missing.length) {
        toast('Missing permissions: ' + missing.join(', ') +
          '. Click Connect again and grant ALL requested permissions in the Facebook dialog.', 'err');
        return;
      }
      try {
        toast('Connected. Fetching your Facebook pages…');
        const r = await api('api_fb_connect', resp.authResponse.accessToken);
        if (r.pages_count === 0) {
          toast('Login succeeded but no pages came back. Check that your account has Facebook page admin access.', 'warn');
        } else {
          toast(`Connected — ${r.pages_count} page${r.pages_count === 1 ? '' : 's'} fetched. Pick which to monitor below.`);
        }
        showAdminTab('fb');
      } catch (e) { toast(e.message, 'err'); }
    });
  }, {
    scope: FB_LOGIN_SCOPE,
    // rerequest forces the dialog to ask for permissions the user previously
    // declined or skipped. Without it, FB silently reuses the partial grant.
    auth_type: 'rerequest',
    return_scopes: true
  });
}

/* ---------------- Native Android integration (Capacitor APK) ---------------- */
// (Auto-recording is disabled. We use the SAF folder-watcher pattern instead —
//  see syncRecordings() below.)

/**
 * Parse a phone-call recording filename. Common patterns we handle:
 *   "Call recording with +91XXXXXXXXXX_2024-01-15-14-30-22.m4a"
 *   "+919876543210_20240115_143022.mp3"
 *   "Outgoing_+91XXXXXXXXXX_15-01-2024.amr"
 *   "Incoming call from John Doe (9876543210) 15-Jan-2024.amr"
 *   "20240115_143022_+919876543210_out.m4a"
 */
function parseRecordingFilename(name, fallbackTimestamp) {
  const lower = name.toLowerCase();
  // Phone — first run of 7-15 digits (optionally + prefix), preferring + form
  let phone = '';
  const plusMatch = name.match(/\+\d{8,15}/);
  if (plusMatch) phone = plusMatch[0];
  else {
    const m = name.match(/(\d{7,15})/);
    if (m) phone = m[1];
  }
  // Direction
  let direction = 'out';
  if (/(incoming|received|\bin[_\-\s]|inbound)/.test(lower)) direction = 'in';
  else if (/(outgoing|outbound|\bout[_\-\s]|dialed|made)/.test(lower)) direction = 'out';
  // Date — try YYYY-MM-DD HH:MM:SS or YYYYMMDD_HHMMSS variants
  let startedAt = fallbackTimestamp || Date.now();
  const dt1 = name.match(/(\d{4})[\-_]?(\d{2})[\-_]?(\d{2})[\-_\sT]+(\d{2})[\-_:]?(\d{2})[\-_:]?(\d{2})/);
  if (dt1) {
    const [, y, mo, d, h, mi, s] = dt1;
    const ts = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();
    if (!isNaN(ts)) startedAt = ts;
  }
  return { phone, direction, startedAt };
}

/**
 * Walk the user's selected recordings folder, find new files, look up the
 * matching lead by phone number, and upload each new recording to the CRM.
 *
 * Skips files we've already uploaded (tracked in localStorage by file URI).
 */
async function syncRecordings(opts) {
  opts = opts || {};
  if (!window.LeadCRMNative || typeof LeadCRMNative.listRecordings !== 'function') {
    toast('Sync only works in the Android app', 'warn');
    return;
  }
  let folderName = '';
  try { folderName = LeadCRMNative.getRecordingFolder() || ''; } catch (e) {}
  if (!folderName) {
    return setupRecordingFolder();
  }

  const stored = Number(localStorage.getItem('rec_last_sync') || 0);
  // Hard floor: never look at files older than 30 minutes from now, even
  // if the stored watermark is from months ago. This prevents a stale
  // watermark (e.g. user picked the folder a year ago) from re-pulling
  // every recording on the device. The gate-by-call-event logic below
  // is the backup; this is the front-line filter.
  const minWatermark = Date.now() - 30 * 60_000;
  const sinceMs = opts.full ? 0 : Math.max(stored, minWatermark);
  const filesJson = LeadCRMNative.listRecordings(sinceMs);
  let files = [];
  try { files = JSON.parse(filesJson || '[]'); } catch (e) { files = []; }

  if (files.length === 0) {
    toast('No new recordings in the folder');
    return;
  }

  // Make sure we have leads loaded for matching
  if (!CRM.cache.lastLeads || CRM.cache.lastLeads.length === 0) {
    try {
      const r = await api('api_leads_list', {});
      CRM.cache.lastLeads = (r.leads || r);
    } catch (_) {}
  }

  // Build a set of "last 7 digits" for every phone we know across leads —
  // used to filter out personal/family calls.
  const knownTails = new Set();
  for (const l of CRM.cache.lastLeads || []) {
    for (const fld of ['phone', 'whatsapp', 'alt_phone']) {
      const d = String(l[fld] || '').replace(/\D/g, '');
      if (d.length >= 7) knownTails.add(d.slice(-7));
    }
  }
  const includeUnmatched = !!opts.includeUnmatched
    || localStorage.getItem('rec_include_unmatched') === '1';

  const uploaded = JSON.parse(localStorage.getItem('rec_uploaded') || '{}');
  let success = 0, failed = 0, skipped = 0, skippedNoMatch = 0;

  // Show progress in dialer view if visible
  const progress = $('#sync-progress');
  if (progress) progress.textContent = `0 / ${files.length}`;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (uploaded[f.uri]) { skipped++; continue; }
    const meta = parseRecordingFilename(f.name, f.modified);
    const digits = String(meta.phone || '').replace(/\D/g, '');
    const tail = digits.slice(-7);
    // SKIP files whose phone number doesn't match a lead in your CRM
    // (personal calls, family, courier, OTPs, etc.)
    if (!includeUnmatched && (!tail || !knownTails.has(tail))) {
      skippedNoMatch++;
      continue;
    }
    // Match the recording's phone number against every lead's
    // phone/whatsapp/alt_phone — last 10 digits comparison so country-code
    // variations (+91, 91, none) don't break the join.
    const tail10 = digits.slice(-10);
    const lead = digits ? (CRM.cache.lastLeads || []).find(l => {
      for (const fld of ['phone', 'whatsapp', 'alt_phone']) {
        const d = String(l[fld] || '').replace(/\D/g, '');
        if (d && d.endsWith(tail10)) return true;
      }
      return false;
    }) : null;
    const leadId = lead ? String(lead.id) : '';

    // If the filename's phone number maps to a lead, that's all the
    // evidence we need — the recording belongs to that lead, period.
    // Earlier we also required a recent call_event from the CRM, which
    // dropped recordings for any call made directly from the phone
    // (without auto-dial / dial-from-CRM). For real-world reps this
    // hid 80%+ of recordings. Now: lead-match wins.
    //
    // The call_event check is only used as a fallback when the phone
    // doesn't match any lead but DOES match a knownTail (alt-format
    // shorthand). Helps catch typos / saved-without-country-code cases.
    if (!includeUnmatched && !lead && digits) {
      try {
        const hr = await api('api_call_hasRecentEvent', meta.phone, 30);
        if (!hr || !hr.matched) {
          skippedNoMatch++;
          continue;
        }
      } catch (_) { /* on API error fall through to upload — better
                       too-permissive than silently dropping */ }
    }
    // Rough duration: ~12 KB/sec for AAC m4a, ~8 KB/sec for amr, ~16 KB/sec for mp3
    const bytesPerSec = /\.(mp3|wav)$/i.test(f.name) ? 16000 : /\.(amr|3gp)$/i.test(f.name) ? 8000 : 12000;
    const durationGuess = Math.max(0, Math.round((Number(f.size) || 0) / bytesPerSec));

    const ok = await new Promise(resolve => {
      const cbName = '__recCB_' + Math.random().toString(36).slice(2, 10);
      window[cbName] = (success, detail) => {
        delete window[cbName];
        resolve({ success, detail });
      };
      try {
        LeadCRMNative.uploadRecordingByUri(
          f.uri, location.origin, CRM.token || '',
          meta.phone || '', meta.direction || 'out',
          durationGuess, leadId,
          new Date(meta.startedAt).toISOString(), f.name, cbName
        );
      } catch (e) {
        delete window[cbName];
        resolve({ success: false, detail: e.message });
      }
    });

    if (ok.success) {
      success++;
      uploaded[f.uri] = Date.now();
    } else {
      failed++;
      console.warn('[leadcrm] upload failed:', f.name, ok.detail);
    }
    if (progress) progress.textContent = `${i + 1} / ${files.length}`;
  }

  localStorage.setItem('rec_uploaded', JSON.stringify(uploaded));
  localStorage.setItem('rec_last_sync', String(Date.now()));
  const parts = [];
  parts.push(`✅ ${success} synced`);
  if (skipped) parts.push(`${skipped} already uploaded`);
  if (skippedNoMatch) parts.push(`${skippedNoMatch} skipped (not in CRM)`);
  if (failed) parts.push(`${failed} failed`);
  toast(parts.join(' · '));
  if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
}

/**
 * First-run onboarding — when a user first signs in on the APK, prompt them
 * to connect their call-recordings folder. Plus exposed via
 * window.testRecordingOnboarding() so the user can paste it into the
 * console to force-show the modal for diagnostic.
 *
 * Skipped silently if:
 *   - We're in a regular browser (no LeadCRMNative bridge — the picker only
 *     exists in the Android app). Browser users get a different nudge.
 *   - User has already picked a folder (getRecordingFolder returns non-empty).
 *   - User has previously dismissed onboarding (rec_onboarding_seen_v2 flag —
 *     bumped from v1 so any user who dismissed before sees the new version).
 */
async function firstRunRecordingPrompt(forceShow) {
  console.log('[onboarding] firstRunRecordingPrompt called, forceShow=', !!forceShow);
  // Browser users have no native picker — silently skip unless forced.
  if (!window.LeadCRMNative || typeof LeadCRMNative.pickRecordingFolder !== 'function') {
    console.log('[onboarding] skip — not in APK (no LeadCRMNative bridge)');
    if (!forceShow) return;
  }
  // Already picked? Nothing to prompt.
  let existingFolder = '';
  try { existingFolder = (window.LeadCRMNative && typeof LeadCRMNative.getRecordingFolder === 'function') ? (LeadCRMNative.getRecordingFolder() || '') : ''; } catch (_) {}
  if (existingFolder && !forceShow) {
    console.log('[onboarding] skip — folder already picked:', existingFolder);
    return;
  }
  // User already dismissed onboarding once — they can re-trigger from
  // Dialer → Settings → Pick recordings folder, or by tapping the
  // permanent banner on the Dialer tab if no folder is set.
  if (localStorage.getItem('rec_onboarding_seen_v2') === '1' && !forceShow) {
    console.log('[onboarding] skip — already dismissed (rec_onboarding_seen_v2=1)');
    return;
  }
  console.log('[onboarding] showing first-run modal');

  const modal = h('div', { class: 'modal-backdrop',
    onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) {
      // Close on backdrop click counts as "skip for now"
      try { localStorage.setItem('rec_onboarding_seen_v2', '1'); } catch (_) {}
      modal.remove();
    } }
  },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '👋 Welcome — connect call recordings'),
        h('button', { class: 'btn icon', onclick: () => {
          try { localStorage.setItem('rec_onboarding_seen_v2', '1'); } catch (_) {}
          modal.remove();
        }, title: 'Maybe later' }, '✕')
      ),
      h('div', { class: 'modal-body' },
        h('p', {},
          'Pick the folder where your phone saves call recordings. From this point on, any call you make to a CRM lead will be automatically attached to that lead — so you can replay it later from the lead\'s page.'
        ),
        h('p', { class: 'muted' },
          h('b', {}, 'Common locations: '),
          'Stock Android → Recordings/Call · Samsung → Call · Xiaomi → MIUI/sound_recorder/call_rec · Truecaller → Truecaller folder.'
        ),
        h('p', { class: 'muted', style: { fontSize: '.82rem' } },
          'You can skip this and set it up later from ',
          h('b', {}, 'Dialer → Settings → Pick recordings folder.'),
          ' Recording must already be enabled in your phone\'s call recorder app.'
        )
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => {
          try { localStorage.setItem('rec_onboarding_seen_v2', '1'); } catch (_) {}
          modal.remove();
          toast('You can connect the folder later from Dialer → Settings.');
        } }, 'Skip — I\'ll do it later'),
        h('button', { class: 'btn primary', onclick: () => {
          modal.remove();
          // Mark seen now so re-opening from setupRecordingFolder doesn't
          // re-trigger the onboarding nudge.
          try { localStorage.setItem('rec_onboarding_seen_v2', '1'); } catch (_) {}
          // Open the actual folder picker
          setupRecordingFolder();
        } }, '📁 Pick folder now')
      )
    )
  );
  document.body.appendChild(modal);
}

// Manual debug hook — paste `testRecordingOnboarding()` in the console to
// force-show the modal regardless of localStorage flags or folder state.
// Useful when "not appearing" reports come in.
window.testRecordingOnboarding = function () {
  return firstRunRecordingPrompt(true);
};

/** First-run flow: ask the user to point the app at their recordings folder. */
function setupRecordingFolder() {
  if (!window.LeadCRMNative || typeof LeadCRMNative.pickRecordingFolder !== 'function') {
    toast('Folder picker only works in the Android app', 'warn');
    return;
  }
  const modal = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '📁 Connect call-recordings folder'),
        h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')
      ),
      h('p', { class: 'muted' },
        'Pick the folder where your phone (or call recorder app) saves call recordings. ',
        'From the moment you connect the folder, ',
        h('b', {}, 'only NEW recordings'),
        ' (calls made after this point) will be uploaded to the CRM and attached to the matching lead. ',
        'Old / personal recordings already in the folder are ignored. Common locations:'
      ),
      h('ul', { class: 'rec-folder-tips' },
        h('li', {}, h('b', {}, 'Stock Android: '), 'Internal storage › Recordings › Call'),
        h('li', {}, h('b', {}, 'Samsung: '), 'Internal storage › Call'),
        h('li', {}, h('b', {}, 'Xiaomi/Redmi: '), 'Internal storage › MIUI › sound_recorder › call_rec'),
        h('li', {}, h('b', {}, 'OnePlus/Realme: '), 'Internal storage › Recordings › Call'),
        h('li', {}, h('b', {}, 'Truecaller: '), 'Internal storage › Truecaller'),
        h('li', {}, h('b', {}, 'Google Phone: '), 'Internal storage › Recorded Calls')
      ),
      h('p', { class: 'muted' }, 'Recording must be enabled separately in your phone\'s call recorder. ' +
        'The CRM only reads the files — it doesn\'t record calls itself.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          window.__onFolderPicked = (ok, name) => {
            delete window.__onFolderPicked;
            if (ok) {
              toast('📁 Folder connected: ' + name);
              modal.remove();
              if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
              // IMPORTANT: set the sync watermark to NOW so we DON'T pull
              // every existing recording in the folder. Old call recordings
              // (personal calls, recordings from before CRM was installed,
              // etc.) shouldn't dump into the CRM. From this point onward,
              // ONLY new recordings (made for calls dialed from the CRM,
              // or calls to known leads) will be synced.
              localStorage.setItem('rec_last_sync', String(Date.now()));
              localStorage.setItem('rec_uploaded', '{}');
              if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
            } else {
              toast('Folder selection cancelled', 'warn');
            }
          };
          try {
            LeadCRMNative.pickRecordingFolder('__onFolderPicked');
          } catch (e) { toast(e.message, 'err'); }
        } }, 'Pick folder')
      )
    )
  );
  document.body.appendChild(modal);
}

/** Reset the folder + clear the upload cache (for "switch folder" flow). */
function resetRecordingFolder() {
  if (!window.LeadCRMNative) return;
  try { LeadCRMNative.clearRecordingFolder(); } catch (e) {}
  localStorage.removeItem('rec_last_sync');
  localStorage.removeItem('rec_uploaded');
  toast('Folder cleared');
  if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
}

// When the native PhoneStateReceiver fires a call event, it calls this function.
window.onLeadCRMCallEvent = function (event, number) {
  try {
    console.log('[leadcrm] native call event:', event, number);
    if (!CRM.user) return;
    const digits = String(number || '').replace(/\D/g, '');
    // Match either the lead currently being dialed (pendingCall) or any lead
    // matching the number that just rang.
    const ctx = CRM.pendingCall;
    const ctxLead = ctx && ctx.lead;
    const matchByNumber = (CRM.cache.lastLeads || []).find(l =>
      digits && String(l.phone || '').replace(/\D/g, '').endsWith(digits.slice(-10))
    );
    const lead = matchByNumber || ctxLead;

    // Log every call into the timeline (best-effort)
    if (digits) {
      const direction = (event === 'incoming_ringing') ? 'in' : 'out';
      api('api_call_logEvent', { phone: number, direction, event }).catch(() => {});
    }

    if (event === 'incoming_ringing' && !matchByNumber && digits) {
      promptSaveAsLead(number);
    } else if (event === 'call_ended') {
      // Native broadcast fired — try to resume from the localStorage stash
      // (works even if WebView was destroyed). _resumePendingCall is idempotent.
      _resumePendingCall('call_ended_native');
      if (!matchByNumber && digits) {
        // No lead match anywhere — offer to save as new lead
        setTimeout(() => {
          if (!document.querySelector('.after-call-modal')) promptSaveAsLead(number);
        }, 1200);
      }
      if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
    }
  } catch (e) { console.error('[leadcrm] callEvent handler:', e); }
};

/**
 * Open the after-call update modal — purely for manual remark + status entry.
 * Recording match + upload happens silently in the background; the user just
 * fills in their note and saves. The recording will be linked to the lead by
 * the time they look at the lead detail again.
 */
async function openAfterCallModalWithRecording(lead, callContext) {
  await openAfterCallModal(lead);
  // Fire the silent background sync — runs independently while the user types.
  if (window.LeadCRMNative && typeof LeadCRMNative.syncCallRecording === 'function') {
    triggerBackgroundRecordingSync(lead, callContext);
  }
}

/**
 * Background: wait 5s for the OS recorder to finalise the file, then ask the
 * native bridge to find the matching recording and upload it. No spinners,
 * no audio players in the modal — the user only sees the remark/status form.
 *
 * Surfaces problems via toast only when there's something the user can fix
 * (folder not picked, folder unreachable). "No recording found" is silent —
 * it usually means the user hasn't enabled call recording on their dialer,
 * which is their choice.
 */
/**
 * Silent background sweep: walks the recording folder, uploads any new
 * lead-matched files since the last sweep. No toasts unless the user
 * needs to act (folder not picked, folder unreachable). Used on app
 * launch so missed-call recordings get picked up automatically.
 */
async function silentBackgroundSync() {
  if (!window.LeadCRMNative || typeof LeadCRMNative.listRecordings !== 'function') return;
  try {
    const folder = LeadCRMNative.getRecordingFolder();
    if (!folder) return; // user hasn't picked a folder yet — don't nag here
    // Save a stash of toast() so we can suppress info-toasts during the silent run
    const realToast = window.toast;
    let suppressedSuccess = 0;
    window.toast = function (msg, kind) {
      // only let warnings through
      if (kind === 'warn' || kind === 'err') return realToast(msg, kind);
      if (typeof msg === 'string' && msg.startsWith('✅')) suppressedSuccess++;
    };
    try {
      await syncRecordings({});
    } finally {
      window.toast = realToast;
    }
    if (suppressedSuccess) {
      console.log('[leadcrm] background sweep done, ' + suppressedSuccess + ' new');
    }
  } catch (e) {
    console.warn('[leadcrm] silent sweep error:', e);
  }
}

function triggerBackgroundRecordingSync(lead, callContext) {
  setTimeout(async () => {
    const cbName = '__cbBgRec_' + Math.random().toString(36).slice(2, 10);
    const result = await new Promise(resolve => {
      window[cbName] = (ok, detail) => {
        delete window[cbName];
        resolve({ ok, detail });
      };
      try {
        LeadCRMNative.syncCallRecording(
          callContext.dialedPhone, lead.id ? String(lead.id) : '',
          Math.max(0, callContext.startedAt - 60_000),
          location.origin, CRM.token || '', cbName
        );
      } catch (e) {
        delete window[cbName];
        resolve({ ok: false, detail: e.message });
      }
    });

    if (result.ok) {
      console.log('[leadcrm] bg recording sync ok');
      // Tiny success toast — non-intrusive
      toast('📼 Recording linked to ' + (lead.name || 'lead'));
      if (typeof refreshDialerHistory === 'function') refreshDialerHistory();
    } else {
      const code = String(result.detail || '');
      if (code === 'no_folder') {
        toast('Pick recordings folder in Dialer → Settings to enable auto-sync', 'warn');
      } else if (code === 'folder_unreachable') {
        toast('Recordings folder no longer accessible — re-pick it in Settings', 'warn');
      } else {
        // 'no_match' / network errors / etc — log but don't bother the user
        console.warn('[leadcrm] bg sync skipped:', code);
      }
    }
  }, 5000);
}

// Shared-intent handler — when user shares a phone number into the app
window.onLeadCRMSharedLead = function (text) {
  if (!CRM.user) return;
  const phoneMatch = String(text).match(/(\+?\d[\d\s\-\(\)]{6,})/);
  const phone = phoneMatch ? phoneMatch[1].replace(/[\s\-\(\)]/g, '') : '';
  const name = String(text).replace(phone, '').trim() || 'Shared Contact';
  setTimeout(() => {
    // Open lead modal with name + phone pre-filled
    const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
      h('h3', {}, '📥 Save as lead?'),
      h('p', { class: 'muted' }, 'Received from another app:'),
      h('pre', { class: 'code-block' }, text),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => modal.remove() }, 'Dismiss'),
        h('button', { class: 'btn primary', onclick: () => {
          modal.remove();
          // Open new lead modal and pre-fill
          openLeadModal();
          setTimeout(() => {
            const f = $('#lead-form'); if (f) {
              if (f.name) f.name.value = name;
              if (f.phone) f.phone.value = phone;
              if (f.whatsapp) f.whatsapp.value = phone;
            }
          }, 200);
        } }, '+ Save as lead')
      )
    ));
    document.body.appendChild(modal);
  }, 300);
};

function promptSaveAsLead(number) {
  const modal = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h3', {}, '📞 Unknown number'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
    h('p', {}, 'Incoming/outgoing call with ', h('b', {}, number)),
    h('p', { class: 'muted' }, 'This number isn\'t in your CRM. Save as a new lead?'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => modal.remove() }, 'Later'),
      h('button', { class: 'btn primary', onclick: () => {
        modal.remove();
        openLeadModal();
        setTimeout(() => {
          const f = $('#lead-form'); if (f) {
            if (f.phone) f.phone.value = number;
            if (f.whatsapp) f.whatsapp.value = number;
            if (f.source) {
              // Add "Incoming Call" as source if not present
              const opt = [...f.source.options].find(o => o.value === 'Incoming Call');
              if (opt) f.source.value = 'Incoming Call';
            }
            if (f.name) f.name.focus();
          }
        }, 200);
      } }, '+ Save as lead')
    )
  ));
  document.body.appendChild(modal);
}

/* ---------------- Web Push subscription ---------------- */
/**
 * Register the browser's Push Manager with our VAPID public key, then send
 * the subscription to the backend so it can push to this device. Idempotent —
 * calling again with an existing subscription just re-syncs it.
 *
 * Once subscribed, the service worker handles `push` events and shows a
 * native banner + sound + vibration EVEN IF THE TAB / INSTALLED APP IS CLOSED.
 * That's the SMS-like behaviour the user wants.
 */
async function registerWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission === 'denied') return;

  // Ask for permission if we haven't yet. Don't be aggressive — only on
  // explicit "default" state. Granted = re-use; Denied = give up silently.
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return;
  }

  const reg = await navigator.serviceWorker.ready;

  // Pull the server's VAPID public key — it's persistent so we cache it.
  let publicKey = sessionStorage.getItem('vapid_pub') || '';
  if (!publicKey) {
    try {
      const r = await api('api_push_publicKey');
      publicKey = r.publicKey || '';
      if (publicKey) sessionStorage.setItem('vapid_pub', publicKey);
    } catch (e) { console.warn('[push] no public key from server:', e.message); return; }
  }
  if (!publicKey) return;

  // Subscribe (or re-use existing). Browsers de-dupe by endpoint, so calling
  // subscribe with the same applicationServerKey is safe and returns the
  // same object.
  let sub;
  try {
    sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8(publicKey)
      });
    }
  } catch (e) {
    console.warn('[push] subscribe failed:', e.message);
    return;
  }

  // Send the subscription to the backend. Even if it's the same one as
  // before, this refreshes the user_id link in case the user has logged
  // in as someone else on this device.
  try {
    await api('api_push_subscribe', sub.toJSON ? sub.toJSON() : sub, navigator.userAgent);
    console.log('[push] subscription registered');
  } catch (e) { console.warn('[push] register on server failed:', e.message); }
}

/**
 * Direct dial modal — pops over whatever view is showing (or even before
 * the router has loaded any view) and tries every available strategy to
 * launch the native Android dialer with the number pre-filled. Used by
 * the call-from-mobile push so users don't have to wait for routing.
 *
 * Strategies tried in order, with a status line per attempt so failures
 * are visible to the user:
 *   1. Capacitor App.openUrl (Android: ACTION_DIAL intent)
 *   2. window.open(tel, '_system')
 *   3. hidden iframe with src=tel:
 *   4. programmatic anchor click
 *   5. plain location.href = tel
 * Plus a giant green CALL NOW button (a real <a href="tel:">) that
 * Android always treats as a hard Intent launch.
 */
function openDialModal(phone) {
  // Don't double-open
  if (document.getElementById('dial-modal-active')) return;
  const tel = 'tel:' + String(phone || '').replace(/\s+/g, '');
  const m = h('div', {
    id: 'dial-modal-active',
    class: 'modal-backdrop',
    style: { background: 'rgba(0,0,0,.85)' }
  });
  const status = h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.5rem', minHeight: '1em' } });
  async function runDial() {
    const cap = window.Capacitor;
    try {
      if (cap && cap.Plugins && cap.Plugins.App && typeof cap.Plugins.App.openUrl === 'function') {
        const r = await cap.Plugins.App.openUrl({ url: tel });
        status.textContent = 'App.openUrl → ' + JSON.stringify(r);
        if (r && r.completed !== false) return;
      }
    } catch (e) { status.textContent = 'App.openUrl threw: ' + e.message; }
    try { const w = window.open(tel, '_system'); if (w) { status.textContent = 'window.open ok'; return; } } catch (_) {}
    try {
      const f = document.createElement('iframe'); f.style.display = 'none'; f.src = tel;
      document.body.appendChild(f); setTimeout(() => f.remove(), 1000);
      status.textContent = 'iframe fired';
    } catch (_) {}
    try {
      const a = document.createElement('a'); a.href = tel; a.style.display = 'none';
      document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 100);
      status.textContent += ' · anchor.click fired';
    } catch (_) {}
    try { location.href = tel; status.textContent += ' · href set'; } catch (_) {}
  }
  m.appendChild(h('div', { class: 'modal', style: { maxWidth: '420px', textAlign: 'center', padding: '1.5rem' } },
    h('div', { style: { fontSize: '4rem' } }, '📞'),
    h('h1', { style: { margin: '.5rem 0 .25rem', fontSize: '1.4rem' } }, 'Call this number'),
    h('p', { style: { fontSize: '1.5rem', fontWeight: '700', fontFamily: 'monospace', margin: '.5rem 0 1.5rem' } }, phone),
    h('a', {
      class: 'btn primary',
      style: { display: 'block', fontSize: '1.4rem', padding: '1.25rem', background: '#10b981', color: '#fff', border: 'none', borderRadius: '12px', textDecoration: 'none', fontWeight: '600' },
      href: tel
    }, '📞 CALL NOW'),
    h('button', {
      class: 'btn ghost', style: { marginTop: '1rem' },
      onclick: () => m.remove()
    }, 'Cancel'),
    status
  ));
  document.body.appendChild(m);
  // Try auto-dial after the modal is in the DOM
  setTimeout(() => runDial().catch(() => {}), 200);
}

/**
 * Apply a URL from a push notification — handles hash-routed SPA paths
 * (/#/foo, #/foo) and absolute URLs. Forces a navigation event so the
 * router definitely fires VIEWS.<name> even if the same hash was set.
 */
/**
 * Navigate the SPA to the URL embedded in a push notification's data.url.
 *
 * Two failure modes we've hit before:
 *   1. The retries (called at 800ms / 2000ms after the initial call) used
 *      to set `location.hash = '#/_'` first to force a hashchange when the
 *      hash was already at the target — but parseHashView('_') doesn't
 *      match any NAV item so navigateTo would briefly fall back to
 *      Dashboard. Users saw a dashboard flash and (in the cold-start
 *      case where retry finished AFTER the page settled) it stuck.
 *   2. The hashchange handler skips when CRM.user is null, so during very
 *      early boot a hash change can be silently dropped.
 *
 * Fix: set location.hash directly (don't bounce through '#/_'). Also call
 * navigateTo() explicitly so we don't depend on hashchange fully — that
 * re-runs the view function and re-reads any ?room= deep-link param.
 */
function applyPushUrl(url) {
  if (!url) return;
  try {
    let target = url;
    if (target.startsWith('/#/')) target = '#' + target.slice(2);  // /#/dial?... → #/dial?...
    else if (target.startsWith('#/')) { /* keep as-is */ }
    else if (target.startsWith('/')) target = '#' + target;
    else { location.href = target; return; }

    // Set the URL hash (updates address bar; harmless if same as current)
    if (location.hash !== target) location.hash = target;

    // Always call navigateTo() directly — the hashchange listener has
    // an `if (!CRM.user) return` guard, AND we want to re-run the view
    // function even if we're already on the right route so deep-link
    // params (e.g. ?room=3) are picked up after a retry.
    if (typeof navigateTo === 'function' && CRM.user) {
      const m = String(target).match(/^#\/([a-z_-]+)/i);
      const id = m && m[1];
      if (id && VIEWS[id]) navigateTo(id);
    }
  } catch (_) {}
}

/**
 * Register the Capacitor app for Firebase Cloud Messaging push.
 *
 * Only runs inside the native APK — browsers and PWAs go through Web Push
 * (registerWebPush) instead. FCM is what makes notifications survive the
 * Android OS killing the WebView, because Google's servers wake the device
 * directly instead of relying on a service worker.
 *
 * Flow:
 *   1. Request POST_NOTIFICATIONS permission (Android 13+)
 *   2. Register with FCM → token is delivered async via the 'registration' event
 *   3. POST the token to /api → fcm_tokens table
 *   4. Wire 'pushNotificationActionPerformed' so tapping a notification
 *      navigates the WebView to the URL we baked into the data payload.
 */
async function registerCapacitorPush() {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return;
  const Push = cap.Plugins && cap.Plugins.PushNotifications;
  if (!Push) {
    console.warn('[push] PushNotifications plugin not present (rebuild APK after npm install)');
    return;
  }
  try {
    let perm = await Push.checkPermissions();
    if (perm.receive !== 'granted') {
      perm = await Push.requestPermissions();
    }
    if (perm.receive !== 'granted') {
      console.warn('[push] notification permission not granted on Android');
      return;
    }

    // Listener BEFORE register() — token can arrive within milliseconds.
    Push.addListener('registration', async (tk) => {
      console.log('[push] FCM token received');
      try {
        await api('api_fcm_register', tk.value, 'android', navigator.userAgent);
        console.log('[push] FCM token sent to server');
      } catch (e) { console.warn('[push] FCM token register failed:', e.message); }
    });

    Push.addListener('registrationError', (err) => {
      console.warn('[push] FCM registrationError:', err && err.error);
    });

    // App in foreground: show a toast so users know a push arrived (otherwise
    // FCM only shows the notification when the app is backgrounded).
    Push.addListener('pushNotificationReceived', (n) => {
      try {
        const t = (n && n.title) || 'Lead CRM';
        const b = (n && n.body)  || '';
        if (typeof toast === 'function') toast(t + (b ? ' — ' + b : ''));
      } catch (_) {}
    });

    // Tap → navigate inside the WebView to the URL we put in `data.url`,
    // OR if it's a dial request, open a direct call modal immediately
    // (bypasses the router entirely so it works even before the SPA boots).
    Push.addListener('pushNotificationActionPerformed', (action) => {
      try {
        const data = (action && action.notification && action.notification.data) || {};
        const url = data.url || '';
        // Quiet debug log — no toast (the toast was a dev-time diagnostic
        // that leaked the raw payload to users; the console line below is
        // visible only via remote debugging).
        try { console.log('[push] action received', { url, tag: data.tag }); } catch (_) {}
        if (!url) return;

        // Special case — dial request. Show a direct modal regardless of
        // route state. Faster + more reliable than going via the router.
        if (url.indexOf('dial?') !== -1 || url.indexOf('phone=') !== -1) {
          const m = url.match(/phone=([^&]+)/);
          const phone = m ? decodeURIComponent(m[1]) : '';
          if (phone) {
            openDialModal(phone);
            return;
          }
        }

        // Fallback — generic URL navigation
        try { sessionStorage.setItem('pendingPushUrl', url); } catch (_) {}
        applyPushUrl(url);
        setTimeout(() => applyPushUrl(url), 800);
        setTimeout(() => applyPushUrl(url), 2000);
      } catch (_) {}
    });

    await Push.register();
  } catch (e) {
    console.warn('[push] Capacitor push register failed:', e && e.message);
  }
}

// Convert the URL-safe base64 VAPID public key into the Uint8Array the
// PushManager API expects.
function _urlBase64ToUint8(s) {
  const padding = '='.repeat((4 - s.length % 4) % 4);
  const base64 = (s + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
  return arr;
}

/* ---------------- Notifications + follow-up popup ---------------- */
let followupPollTimer = null;
let newLeadPollTimer = null;
function startFollowupPolling() {
  if (followupPollTimer) clearInterval(followupPollTimer);
  followupPollTimer = setInterval(refreshNotifs, 60_000);
  // Poll for new leads every 30s — fires a popup + toast when one arrives
  if (newLeadPollTimer) clearInterval(newLeadPollTimer);
  newLeadPollTimer = setInterval(checkNewLeads, 30_000);
  // Also fire an immediate check so the baseline ID is set
  checkNewLeads();
}

/**
 * Refresh the Leads listing. Re-fetches without leaving the page,
 * spins the icon while loading, and surfaces a toast when done.
 */
async function refreshLeads() {
  const btn = document.getElementById('btn-refresh-leads');
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
  try {
    await loadLeads();
    // Update baseline so the new-lead poller doesn't re-fire for leads
    // we just pulled in.
    const list = (CRM.cache.lastLeads || []);
    if (list.length) CRM._lastSeenLeadId = Math.max(...list.map(l => Number(l.id) || 0));
    toast('🔄 Leads refreshed (' + list.length + ')');
  } catch (e) { toast(e.message, 'err'); }
  finally {
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
  }
}

/**
 * Background poller — checks every 30s for new leads with id > last seen.
 * Shows a popup + toast when a new lead arrives. Auto-pulls them into the
 * leads listing if it's currently visible.
 */
async function checkNewLeads() {
  if (!CRM.user) return;
  // Skip polling while the user is actively typing on the dialpad — the
  // tiny background fetch + DOM updates were causing keystroke lag.
  if (location.hash === '#/dialer' && _dialerState && _dialerState.tab === 'pad') return;
  try {
    const d = await api('api_leads_list', { limit: 5 });
    const leads = (d && (d.leads || d)) || [];
    if (!leads.length) return;
    const newest = Math.max(...leads.map(l => Number(l.id) || 0));
    const baseline = Number(CRM._lastSeenLeadId || 0);
    if (!baseline) {
      // First poll — set baseline silently
      CRM._lastSeenLeadId = newest;
      return;
    }
    if (newest > baseline) {
      const fresh = leads
        .filter(l => Number(l.id) > baseline)
        .sort((a, b) => Number(a.id) - Number(b.id));
      CRM._lastSeenLeadId = newest;
      if (fresh.length === 0) return;
      // Show toast + system notification (if granted) + in-app popup
      const summary = fresh.length === 1
        ? `🎯 New lead: ${fresh[0].name || fresh[0].phone || 'Unknown'}`
        : `🎯 ${fresh.length} new leads received`;
      toast(summary);
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          fresh.slice(0, 3).forEach(l => new Notification('🎯 New lead', {
            body: `${l.name || ''} ${l.phone || ''}\nSource: ${l.source || '—'}`,
            tag: 'lead-' + l.id
          }));
        } else if ('Notification' in window && Notification.permission === 'default') {
          // Ask once on first arrival
          Notification.requestPermission().catch(() => {});
        }
      } catch (_) {}
      popupNewLeads(fresh);
      // If the user is on the leads page, refresh inline
      if (location.hash === '#/leads' && typeof loadLeads === 'function') {
        loadLeads();
      }
    }
  } catch (e) { console.warn('[leadcrm] new-lead poll error:', e.message); }
}

let _newLeadPopupShown = false;
function popupNewLeads(leads) {
  if (_newLeadPopupShown) return;
  _newLeadPopupShown = true;
  const close = () => { modal.remove(); _newLeadPopupShown = false; };
  const modal = h('div', { class: 'modal-backdrop popup-new-lead', onclick: ev => { if (ev.target === modal) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, '🎯 ' + (leads.length === 1 ? 'New lead' : leads.length + ' new leads')),
        h('button', { class: 'btn icon', onclick: close }, '✕')
      ),
      h('ul', { class: 'new-lead-list' }, ...leads.slice(0, 6).map(l => h('li', {},
        h('div', { class: 'new-lead-row' },
          h('div', { class: 'nl-meta' },
            h('div', {}, h('b', {}, l.name || '—')),
            h('div', { class: 'muted' }, (l.phone || '') + ' · ' + (l.source || '—'))
          ),
          h('button', { class: 'btn sm primary', onclick: () => { close(); openLeadModal(l.id); } }, 'Open')
        )
      ))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, 'Dismiss'),
        h('button', { class: 'btn primary', onclick: () => { close(); navigateTo('leads'); } }, 'See all leads')
      )
    )
  );
  document.body.appendChild(modal);
  // Try to play a soft notification ping (browser-policy permitting)
  try {
    const audio = new Audio('data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjQ1LjEwMAAAAAAAAAAAAAAA//tQwAAACQAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDA');
    audio.volume = 0.3; audio.play().catch(() => {});
  } catch (_) {}
}
/**
 * Refresh the top-of-screen announcement banner. Renders one banner card
 * per active, non-dismissed, non-expired announcement. Called at boot and
 * every 60 seconds so a freshly-posted admin announcement appears for
 * already-logged-in users without them needing to reload.
 */
async function refreshAnnouncements() {
  const bar = document.getElementById('announce-bar');
  if (!bar) return;
  let rows;
  try { rows = await api('api_announcements_active'); }
  catch (_) { return; }
  bar.innerHTML = '';
  (rows || []).forEach(a => {
    const card = h('div', { class: 'announce-card sev-' + a.severity },
      h('div', { class: 'announce-text' },
        h('b', {}, a.title || ''),
        a.body ? h('span', { class: 'announce-body' }, ' — ' + a.body) : null
      ),
      a.is_dismissible ? h('button', {
        class: 'announce-close',
        title: 'Dismiss',
        onclick: async () => {
          try { await api('api_announcements_dismiss', a.id); card.remove(); }
          catch (e) { toast(e.message, 'err'); }
        }
      }, '✕') : null
    );
    bar.appendChild(card);
  });
}

/* ---------------- In-app chat notification popup ----------------------
 * For browser users (or APK users with the app open) — when a teammate
 * sends a chat message we slide a Slack-style toast in from the bottom
 * right with sender name, room, and a preview. Click → opens the
 * conversation. Auto-dismiss after 8 seconds; stack up to 3.
 *
 * Suppressed when the user is on /#/teamchat AND has THAT specific room
 * already open — no point flashing a popup for the conversation you're
 * actively reading.
 *
 * Strategy: watermark by created_at timestamp instead of message-id Set.
 * Reason: on login the seed used to add EVERY existing-unread message to
 * a "seen" set; if the seed and a real new message raced (both included
 * in the first poll response), the new message also got marked as seen
 * and never toasted. Watermark is unambiguous — anything newer than the
 * last-seen timestamp is fresh.
 * -------------------------------------------------------------------- */

let _lastSeenChatAt = '0';   // ISO timestamp of the newest message we've toasted
let _chatPollTimer = null;

/**
 * Update the sidebar badge next to "Team chat" with the current unread
 * count. Cheap call (single COUNT-style query on the server). Runs on
 * the same loop as the toast poll so the two stay in sync.
 */
async function _updateChatBadge() {
  try {
    const r = await api('api_chat_unreadCount');
    const n = Number(r && r.unread || 0);
    document.querySelectorAll('.nav-count[data-count-key="chat_unread"]').forEach(el => {
      el.textContent = String(n);
      el.hidden = n === 0;
    });
  } catch (_) {}
}

async function _chatPollOnce() {
  if (document.visibilityState === 'hidden') return;
  // Always refresh the badge; even if no NEW messages, the user might have
  // read some elsewhere and the count needs to come down.
  _updateChatBadge();
  let rows;
  try { rows = await api('api_chat_recent_unread'); }
  catch (e) {
    // The backend rejects with "not enabled" if the role isn't in the
    // allowed_roles config. That's not an error worth toasting; just be
    // quiet about it (still log to console).
    if (!String(e.message || '').includes('not enabled')) {
      console.warn('[chat-popup] poll failed:', e.message);
    }
    return;
  }
  if (!rows || !rows.length) return;

  const fresh = rows.filter(r => String(r.created_at) > _lastSeenChatAt);
  if (!fresh.length) return;
  _lastSeenChatAt = String(fresh[0].created_at);

  [...fresh].reverse().forEach(r => {
    const onChatTab = parseHashView() === 'teamchat';
    const openRoomMatches = window._tcOpenRoomId === r.room_id;
    if (onChatTab && openRoomMatches) return;
    console.log('[chat-popup] new message →', r.user_name, ':', String(r.body || '').slice(0, 60));
    showChatToast(r);
    // Belt-and-braces — also fire a native browser Notification if we have
    // permission. So even if the in-app toast is hidden behind something
    // (or CSS fails for some reason), the user still sees an OS-level
    // banner. Skips silently if permission is denied/default.
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const n = new Notification('💬 ' + (r.user_name || 'Teammate'), {
          body: String(r.body || '').slice(0, 200),
          tag: 'chat-' + r.room_id,
          icon: '/icon-192.png'
        });
        n.onclick = () => {
          window.focus();
          location.hash = '#/teamchat?room=' + r.room_id;
          n.close();
        };
      }
    } catch (_) {}
  });
}

function startChatNotificationPolling() {
  if (_chatPollTimer) clearInterval(_chatPollTimer);
  console.log('[chat-popup] polling started');

  // Seed — set the watermark to the newest existing unread so we don't
  // immediately toast every old unread on login. After the seed completes,
  // immediately fire the first real poll (rather than waiting 10s) so a
  // message that arrived in the gap between seed and first interval
  // doesn't have to wait the full poll cycle to surface.
  api('api_chat_recent_unread').then(rows => {
    if (rows && rows.length) {
      _lastSeenChatAt = String(rows[0].created_at);
      console.log('[chat-popup] seeded watermark at', _lastSeenChatAt, '· existing unread:', rows.length);
    } else {
      console.log('[chat-popup] no existing unread on seed');
    }
    // Initial badge paint so the user sees the count immediately on login,
    // not 10s later on the first interval tick.
    _updateChatBadge();
  }).catch(e => {
    if (!String(e.message || '').includes('not enabled')) {
      console.warn('[chat-popup] seed failed:', e.message);
    }
    _updateChatBadge();
  });

  // Poll every 10s (was 15s — tightened for snappier in-app feedback)
  _chatPollTimer = setInterval(_chatPollOnce, 10_000);

  // ALSO fire whenever the tab regains focus — covers the case where the
  // user came back from another tab / app and we want to immediately show
  // anything that arrived while polling was paused.
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _chatPollOnce();
  });
}

// Manual test hook — paste `testChatToast()` in the browser console to
// verify the toast UI renders correctly. Useful when "popup not coming"
// could be a UI bug vs a polling/data bug.
window.testChatToast = function () {
  showChatToast({
    id: Date.now(),
    room_id: 1,
    room_label: '#team',
    room_type: 'channel',
    user_id: 0,
    user_name: 'Test User',
    body: 'This is a test in-app chat notification. If you see this, the popup UI works.',
    created_at: new Date().toISOString()
  });
};

function showChatToast(msg) {
  let layer = document.getElementById('chat-toast-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'chat-toast-layer';
    document.body.appendChild(layer);
  }
  // Cap to 3 visible at a time — pop the oldest off the bottom
  while (layer.children.length >= 3) layer.removeChild(layer.firstChild);

  const t = h('div', { class: 'chat-toast' },
    h('div', { class: 'chat-toast-head' },
      h('span', { class: 'chat-toast-icon' }, '💬'),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { class: 'chat-toast-from' }, msg.user_name || 'Teammate',
          h('span', { class: 'chat-toast-room' }, ' · ' + (msg.room_label || '')))
      ),
      h('button', { class: 'chat-toast-close', onclick: () => t.remove() }, '✕')
    ),
    h('div', { class: 'chat-toast-body' },
      String(msg.body || '').slice(0, 180) + (String(msg.body || '').length > 180 ? '…' : '')
    ),
    h('div', { class: 'chat-toast-actions' },
      h('button', { class: 'btn sm primary', onclick: () => {
        t.remove();
        // Deep-link to the specific conversation
        location.hash = '#/teamchat?room=' + msg.room_id;
      } }, 'Open')
    )
  );
  layer.appendChild(t);
  // Allow the browser to paint the initial off-screen position before
  // toggling the .show class so the slide-in transition actually animates.
  requestAnimationFrame(() => t.classList.add('show'));
  // Auto-dismiss after 8s
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 320);
  }, 8000);
}

async function refreshNotifs() {
  try {
    const d = await api('api_notifications_mine');
    const n = (d.counts.overdue || 0) + (d.counts.due_today || 0) + (d.counts.unread || 0);
    const badge = $('#notif-count');
    if (badge) { badge.textContent = n; badge.hidden = n === 0; }
    // Update sidebar count badges next to New leads / Overdue / Due today / Upcoming
    document.querySelectorAll('.nav-count').forEach(el => {
      const key = el.getAttribute('data-count-key');
      const c = (d.counts && d.counts[key]) || 0;
      el.textContent = c;
      el.hidden = c === 0;
    });
    if ((d.counts.due_today || 0) + (d.counts.overdue || 0) > 0) popupFollowupDue(d);
  } catch (_) {}
}

// Track which follow-ups we've already fired the popup for so each new reminder
// pops exactly once when its time arrives, instead of either spamming or
// firing only once per session.
const _firedFollowupIds = new Set();
let _popupShown = false;

function popupFollowupDue(d) {
  // Filter the urgent items down to ones we have NOT yet shown a popup for.
  // Use the followup id when available, otherwise lead_id+due_at as a stable key.
  const all = [...(d.overdue || []), ...(d.due_today || [])];
  const fresh = all.filter(f => {
    const key = f.id ? 'fu:' + f.id : 'lead:' + f.lead_id + '@' + f.due_at;
    if (_firedFollowupIds.has(key)) return false;
    _firedFollowupIds.add(key);
    return true;
  });
  if (!fresh.length) return;

  // Browser-level Notification (desktop / Android lock screen) — request
  // permission once on first follow-up arrival; subsequent fires use the
  // already-granted permission silently.
  try {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        fresh.slice(0, 3).forEach(f => new Notification('⏰ Follow-up due', {
          body: `${f.lead_name || ''} ${f.lead_phone ? '· ' + f.lead_phone : ''}\nDue: ${new Date(f.due_at).toLocaleString()}` +
            (f.latest_remark ? `\n${String(f.latest_remark).slice(0, 80)}` : ''),
          tag: 'fu-' + (f.id || (f.lead_id + '-' + f.due_at)),
          requireInteraction: true
        }));
      } else if (Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    }
  } catch (_) {}

  if (_popupShown) return;
  const urgent = fresh.slice(0, 5);
  _popupShown = true;
  const close = () => { modal.remove(); _popupShown = false; };
  const modal = h('div', { class: 'modal-backdrop popup-followup' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, '⏰ Follow-ups due'), h('button', { class: 'btn icon', onclick: close }, '✕')),
      h('ul', { class: 'followup-list' }, ...urgent.map(f => {
        const phone = String(f.lead_phone || '').trim();
        const telHref = phone ? 'tel:' + phone.replace(/[^\d+]/g, '') : null;
        return h('li', {},
          h('b', {}, f.lead_name || '—'), ' — ', f.lead_phone || '',
          h('div', { class: 'muted' }, 'Due: ', fmtDate(f.due_at)),
          f.latest_remark ? h('div', { class: 'fu-latest-remark', style: { marginTop: '.25rem' } },
            '💬 ', String(f.latest_remark).slice(0, 160) + (String(f.latest_remark).length > 160 ? '…' : '')) : null,
          f.note ? h('div', {}, f.note) : null,
          h('div', { class: 'actions' },
            telHref ? h('a', { class: 'btn sm primary', href: telHref }, '📞 Call') : null,
            f.id ? h('button', { class: 'btn sm primary', onclick: () => openNextFollowupModal(f, () => refreshNotifs()) }, '⏰ Next follow-up') : null,
            h('button', { class: 'btn sm ghost', onclick: () => { close(); navigateTo('leads'); setTimeout(() => openLeadModal(f.lead_id), 300); } }, 'Open lead')
          )
        );
      })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, 'Later'),
        h('button', { class: 'btn primary', onclick: () => { close(); navigateTo('followups'); } }, 'See all')
      )
    )
  );
  document.body.appendChild(modal);
}
async function showNotifs() {
  const d = await api('api_notifications_mine');
  const list = (d.unread_notifications || []);
  const modal = h('div', { class: 'modal-backdrop', onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) modal.remove(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, 'Notifications'), h('button', { class: 'btn icon', onclick: () => modal.remove() }, '✕')),
      list.length
        ? h('ul', { class: 'notif-list' }, ...list.map(n => h('li', {}, h('b', {}, n.title || ''), h('br'), n.body || '')))
        : h('p', { class: 'muted' }, 'All clear. ✨'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: async () => { try { await api('api_notifications_read_all'); refreshNotifs(); modal.remove(); } catch (e) { toast(e.message, 'err'); } } }, 'Mark all read')
      )
    )
  );
  document.body.appendChild(modal);
}
