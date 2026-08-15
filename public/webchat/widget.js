/* SmartCRM Web Chat Widget — WEBCHAT_v1 (inline, ChatGPT-style)
 * Embed:
 *   <div id="smartcrm-chat"></div>
 *   <script src="https://crm.smartcrmsolution.com/webchat/<slug>/widget.js" defer></script>
 * Renders a full inline chat panel into #smartcrm-chat (like ChatGPT). If that div is
 * absent, falls back to a floating bubble. Talks to /webchat/<slug>/{start,message}.
 */
(function () {
  'use strict';
  var me = document.currentScript || (function () { var s = document.getElementsByTagName('script'); return s[s.length - 1]; })();
  var src = (me && me.src) || '';
  var mm = src.match(/\/webchat\/([^\/]+)\/widget\.js/);
  var SLUG = (mm && mm[1]) || 'default';
  var API = src.replace(/\/widget\.js.*$/, '');
  var T = { primary: '#128C7E', title: 'Chat with us', sub: 'AI · powered by Gemini' };
  var sessionId = null, busy = false, done = false, root, body, chips, ta, sendB;

  function el(t, a, x) { var e = document.createElement(t); if (a) for (var k in a) e.setAttribute(k, a[k]); if (x != null) e.textContent = x; return e; }
  function css() {
    if (document.getElementById('scw-css')) return;
    var s = el('style', { id: 'scw-css' });
    s.textContent = [
      '#smartcrm-chat{--p:' + T.primary + '}',
      '.scw{display:flex;flex-direction:column;background:#fff;border:1px solid #e6eaf0;border-radius:16px;overflow:hidden;height:600px;max-height:82vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 10px 40px rgba(2,6,23,.08)}',
      '.scw-h{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid #e6eaf0}',
      '.scw-av{width:30px;height:30px;border-radius:50%;background:var(--p,#128C7E);color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px}',
      '.scw-h .t{font-weight:700;font-size:15px;color:#1e293b}.scw-h .s{font-size:11px;color:#64748b}',
      '.scw-b{flex:1;overflow-y:auto;padding:18px 0;background:#f7f8fa}',
      '.scw-turn{padding:12px 0}.scw-turn.bot{background:#fff}',
      '.scw-in{max-width:660px;margin:0 auto;display:flex;gap:14px;padding:0 20px}',
      '.scw-ic{width:30px;height:30px;border-radius:7px;flex:0 0 30px;display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff}',
      '.scw-turn.bot .scw-ic{background:var(--p,#128C7E)}.scw-turn.me .scw-ic{background:#475569}',
      '.scw-tx{font-size:14.5px;line-height:1.6;padding-top:4px;white-space:pre-wrap;word-wrap:break-word;color:#1e293b}',
      '.scw-chips{max-width:660px;margin:8px auto 0;padding:0 20px 0 64px;display:flex;flex-wrap:wrap;gap:8px}',
      '.scw-chip{border:1px solid var(--p,#128C7E);color:var(--p,#128C7E);background:#fff;border-radius:999px;padding:7px 14px;font-size:13px;cursor:pointer}',
      '.scw-f{border-top:1px solid #e6eaf0;padding:14px;background:#fff}',
      '.scw-ib{max-width:660px;margin:0 auto;display:flex;gap:10px;align-items:flex-end;border:1px solid #cbd5e1;border-radius:14px;padding:8px 10px}',
      '.scw-ib textarea{flex:1;border:none;outline:none;resize:none;font-size:14.5px;font-family:inherit;max-height:120px;padding:6px 4px}',
      '.scw-send{border:none;background:var(--p,#128C7E);color:#fff;border-radius:10px;width:40px;height:40px;font-size:17px;cursor:pointer}',
      '.scw-note{max-width:660px;margin:6px auto 0;font-size:11px;color:#94a3b8;text-align:center}',
      '.scw-typ{display:inline-flex;gap:3px}.scw-typ i{width:6px;height:6px;border-radius:50%;background:#9aa7b8;animation:scwB 1s infinite}.scw-typ i:nth-child(2){animation-delay:.15s}.scw-typ i:nth-child(3){animation-delay:.3s}',
      '@keyframes scwB{0%,60%,100%{opacity:.3}30%{opacity:1}}'
    ].join('');
    document.head.appendChild(s);
  }

  function build(container) {
    css();
    root = el('div', { class: 'scw' });
    root.innerHTML =
      '<div class="scw-h"><div class="scw-av">✦</div><div><div class="t"></div><div class="s"></div></div></div>' +
      '<div class="scw-b"></div>' +
      '<div class="scw-f"><div class="scw-ib"><textarea rows="1" placeholder="Message…"></textarea><button class="scw-send">➤</button></div><div class="scw-note">Powered by SmartCRM · Gemini</div></div>';
    container.appendChild(root);
    body = root.querySelector('.scw-b'); ta = root.querySelector('textarea'); sendB = root.querySelector('.scw-send');
    root.querySelector('.scw-h .t').textContent = T.title;
    root.querySelector('.scw-h .s').textContent = T.sub;
    sendB.onclick = submit;
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
    ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; });
  }

  function turn(who, text) {
    var t = el('div', { class: 'scw-turn ' + who });
    var inner = el('div', { class: 'scw-in' });
    var ic = el('div', { class: 'scw-ic' }, who === 'bot' ? '✦' : 'You'[0]);
    var tx = el('div', { class: 'scw-tx' }); tx.textContent = text;
    inner.appendChild(ic); inner.appendChild(tx); t.appendChild(inner); body.appendChild(t);
    body.scrollTop = body.scrollHeight; return t;
  }
  function typing(on) {
    var e = body.querySelector('.scw-typ-row');
    if (on && !e) { var r = el('div', { class: 'scw-turn bot scw-typ-row' }); r.innerHTML = '<div class="scw-in"><div class="scw-ic">✦</div><div class="scw-tx"><span class="scw-typ"><i></i><i></i><i></i></span></div></div>'; body.appendChild(r); body.scrollTop = body.scrollHeight; }
    if (!on && e) e.remove();
  }
  function renderChips(buttons) {
    var old = body.querySelector('.scw-chips'); if (old) old.remove();
    if (!buttons || !buttons.length) return;
    var c = el('div', { class: 'scw-chips' });
    buttons.forEach(function (label) { var q = el('button', { class: 'scw-chip' }, label); q.onclick = function () { if (busy || done) return; send(label); }; c.appendChild(q); });
    body.appendChild(c); body.scrollTop = body.scrollHeight;
  }
  function applyTheme(x) { if (!x) return; if (x.primary) { T.primary = x.primary; if (root) root.parentElement.style.setProperty('--p', x.primary); } if (x.title && root) root.querySelector('.scw-h .t').textContent = x.title; if (x.sub && root) root.querySelector('.scw-h .s').textContent = x.sub; }

  async function post(pth, payload) {
    var r = await fetch(API + pth, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
    if (!r.ok) throw new Error('http ' + r.status); return r.json();
  }
  async function start() {
    try { var d = await post('/start', { url: location.href, ref: document.referrer }); sessionId = d.sessionId; applyTheme(d.theme); if (d.greeting) turn('bot', d.greeting); renderChips(d.buttons); }
    catch (e) { turn('bot', 'Sorry, chat is unavailable right now.'); }
  }
  function submit() { var v = ta.value.trim(); if (!v) return; ta.value = ''; ta.style.height = 'auto'; send(v); }
  async function send(text) {
    if (busy || done || !sessionId) return;
    busy = true; turn('me', text); renderChips([]); typing(true);
    try { var d = await post('/message', { sessionId: sessionId, text: text }); typing(false); if (d.reply) turn('bot', d.reply); renderChips(d.buttons); if (d.done) { done = true; ta.disabled = true; sendB.disabled = true; ta.placeholder = 'Chat ended'; } }
    catch (e) { typing(false); turn('bot', 'Hmm, something went wrong. Please try again.'); }
    busy = false;
  }

  function init() {
    var c = document.getElementById('smartcrm-chat');
    if (!c) { c = el('div', { id: 'smartcrm-chat', style: 'position:fixed;right:20px;bottom:20px;width:370px;max-width:calc(100vw - 32px);z-index:2147483000' }); document.body.appendChild(c); }
    build(c); start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
