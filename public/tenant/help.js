/* PAGE_HELP_v1 (2026-07-19) — per-page contextual Help.
 * Self-contained: injects a floating "?" button + a slide-in drawer.
 * The drawer ONLY ever shows help for the page the user is currently on
 * (keyed off location.hash) and never navigates away. "Show me" highlights
 * the relevant control on the current page by matching visible text.
 * Loaded once from index.html; no dependency on app.js internals. */
(function () {
  'use strict';
  if (window.__pageHelpLoaded) return;
  window.__pageHelpLoaded = true;

  /* ---- content: one entry per page key (first hash segment) ---- */
  var GENERIC = {
    title: 'This page',
    intro: 'Quick tips for what you can do here.',
    topics: [
      { q: 'How do I get around?', steps: ['Use the left sidebar to switch between sections.', 'The ? Help button is always here — it changes to match the page you are on.'] },
      { q: 'Works on mobile?', steps: ['Yes — everything here is built to work on your phone in the app. Tap the ? any time.'] }
    ]
  };

  var HELP = {
    leads: {
      title: 'Leads', icon: '🧲',
      intro: 'Add, update and follow up on your leads.',
      topics: [
        { q: 'How do I add a new lead?', steps: ['Tap the “＋ New Lead” button.', 'Enter name and phone (required).', 'Pick a status, then Save.'], find: ['new lead'] },
        { q: 'How do I update a lead?', steps: ['Tap any lead row in the list to open it.', 'Change the fields you need — status, follow-up date, details.', 'Tap Save. Changes appear in the timeline.'] },
        { q: 'How do I add a remark / note?', steps: ['Open the lead by tapping its row.', 'Type in the Remark box at the top.', 'Save — it is stamped with your name and time in the timeline.'] },
        { q: 'How do I set a follow-up?', steps: ['Open the lead and set the Follow-up date.', 'It shows in your follow-up list on the Dashboard.'] },
        { q: 'How do I call or WhatsApp a lead?', steps: ['Open the lead, then tap the 📞 Call or 💬 WhatsApp icon on the row.', 'On mobile the call opens your dialer directly.'] }
      ]
    },
    leadpool: {
      title: 'Lead Pool', icon: '🎣',
      intro: 'Shared unassigned leads anyone can pull.',
      topics: [
        { q: 'How do I take a lead from the pool?', steps: ['Tap Pull on a lead — it becomes yours and moves to your list.'], find: ['pull'] },
        { q: 'What is the pool?', steps: ['Leads with no owner sit here so any agent can claim them.'] }
      ]
    },
    dashboard: {
      title: 'Dashboard', icon: '📊',
      intro: 'Your daily snapshot.',
      topics: [
        { q: 'What do Attempted vs Pending mean?', steps: ['Attempted = leads your team has already actioned.', 'Pending = leads still waiting for a first touch.'], find: ['attempted', 'pending'] },
        { q: 'How do I change the date range?', steps: ['Use the date filter at the top.', 'Pick Today, This week, or a custom range.'], find: ['today', 'week', 'date'] },
        { q: 'Where are my follow-ups?', steps: ['The "Follow-ups due" card lists who to contact today. Tap one to open it.'], find: ['follow'] }
      ]
    },
    whatsbot: {
      title: 'WhatsApp', icon: '💬',
      intro: 'Chat, templates, campaigns and the AI bot.',
      topics: [
        { q: 'How do I send a WhatsApp message?', steps: ['Open a chat, or tap ＋ New chat.', 'Pick an approved template, or type a reply inside the 24-hour window.', 'Send.'], find: ['new chat', 'send'] },
        { q: 'How does the AI bot reply?', steps: ['The bot answers new customer messages automatically.', 'It goes quiet when a human agent replies, and resumes based on your resume setting.'], find: ['bot'] },
        { q: 'How do I send a form to a customer?', steps: ['Set it up in AI Assistant → Bot Settings → "Send a WhatsApp form".', 'Choose "after the bot\'s 1st reply" or a keyword.', 'Answers come back into the lead\'s remark.'], find: ['form'] },
        { q: 'Start a bulk campaign?', steps: ['Open Workspace / Campaigns → New campaign.', 'Pick a template and your audience, then send.'], find: ['campaign'] }
      ]
    },
    aibot: {
      title: 'AI Assistant (Bot)', icon: '🤖',
      intro: 'Configure how the AI bot chats and sends forms.',
      topics: [
        { q: 'How do I turn the bot on/off?', steps: ['Open the ⚙️ Bot Settings tab.', 'Toggle Enable, then Save bot settings.'], find: ['bot settings', 'enable', 'save bot'] },
        { q: 'When should it stop for a human?', steps: ['The bot pauses when an agent replies and resumes after your "resume after idle" time.', 'Set that time in Bot Settings.'], find: ['resume', 'idle'] },
        { q: 'How do I make the bot send a form?', steps: ['In Bot Settings open "📋 Send a WhatsApp form".', 'Pick the form + trigger: after the 1st reply, or a keyword.', 'Enable and Save form rule.'], find: ['send a whatsapp form', 'save form rule'] },
        { q: 'Where do form answers go?', steps: ['Into the customer\'s lead — added to the Remark timeline automatically.'] }
      ]
    },
    reports: {
      title: 'Reports', icon: '📈',
      intro: 'Build and export reports.',
      topics: [
        { q: 'How do I build a report?', steps: ['Tap ＋ New report.', 'Choose the columns and filters you want.', 'Save it to reuse, or Export to Excel.'], find: ['new report', 'report'] },
        { q: 'How do I export to Excel?', steps: ['Open a report and tap Export → Excel.'], find: ['export'] }
      ]
    },
    reportbuilder: { alias: 'reports' },
    campaigns: {
      title: 'Workspace / Campaigns', icon: '🗂️',
      intro: 'Bulk outreach and re-engagement.',
      topics: [
        { q: 'How do I start a campaign?', steps: ['Tap New campaign.', 'Pick a WhatsApp template and choose your audience.', 'Review and send.'], find: ['new campaign', 'campaign'] },
        { q: 'Re-target people who did not reply?', steps: ['Use Smart Retargeting to build an audience from who read / ignored a past campaign.'], find: ['retarget'] }
      ]
    },
    customers: {
      title: 'Customers', icon: '👥',
      intro: 'Convert leads into customers and track them.',
      topics: [
        { q: 'How do I convert a lead to a customer?', steps: ['Open the lead and tap Convert.', 'Fill the customer details and Save.'], find: ['convert'] },
        { q: 'How do I see customer reports?', steps: ['Use the Report tab to filter by product, stage or owner.'], find: ['report'] }
      ]
    },
    wapackinbox: {
      title: 'Team Inbox', icon: '📥',
      intro: 'One shared WhatsApp queue for the whole team.',
      topics: [
        { q: 'How do I take a chat?', steps: ['Tap Claim on a conversation — it becomes yours.'], find: ['claim'] },
        { q: 'How do I hand a chat to a teammate?', steps: ['Open the chat and tap Assign or Transfer, pick the agent, add a note.'], find: ['assign', 'transfer'] },
        { q: 'How do I close a chat?', steps: ['Tap Resolve when done. Reopen any time if the customer replies.'], find: ['resolve'] }
      ]
    },
    wapackforms: {
      title: 'Forms & WebViews', icon: '📝',
      intro: 'Capture details inside the WhatsApp chat.',
      topics: [
        { q: 'How do I make a form?', steps: ['Tap ＋ New form.', 'Add fields (name, type, required).', 'Save. Set a Flow ID if you want the native in-chat form.'], find: ['new form'] },
        { q: 'How does the bot send it?', steps: ['Use the "🤖 AI Bot auto-send" box: pick "after the 1st reply" or a keyword.', 'You can also set this in AI Assistant → Bot Settings.'], find: ['auto-send', 'ai bot auto'] },
        { q: 'How do I test a form?', steps: ['Tap 📤 Send test on a form and enter a WhatsApp number.'], find: ['send test'] },
        { q: 'Where are the answers?', steps: ['On the form\'s Responses, and inside each customer\'s lead remark.'], find: ['responses'] }
      ]
    },
    wapackshop: {
      title: 'Storefront', icon: '🛒',
      intro: 'Build your store, add products, share the link, get orders.',
      topics: [
        { q: 'How do I add products?', steps: ['Tap ＋ Add product.', 'Type it manually, paste a product URL, or scan a photo/menu — the system fills it in.', 'Preview and Save.'], find: ['add product'] },
        { q: 'How do I upload from a URL?', steps: ['Tap Add from URL, paste the product link, and the image, name and price are pulled in.', 'Edit anything, then Save.'], find: ['from url', 'url'] },
        { q: 'How do I scan a menu / photo?', steps: ['Tap Scan image and upload a photo of your menu or product list.', 'The system reads the items and prices — review, edit, then add them all.'], find: ['scan'] },
        { q: 'How do I share my store?', steps: ['Copy your store link and send it on WhatsApp / Instagram / anywhere.', 'Customers open it, add to cart and place an order — no app needed.'], find: ['copy', 'store link', 'link'] },
        { q: 'Where do orders go?', steps: ['Each order becomes a lead with the items in the remark, and you get a WhatsApp/notification alert.'], find: ['orders'] }
      ]
    },
    wapackretarget: {
      title: 'Smart Retargeting', icon: '🎯',
      intro: 'Re-message people based on how they engaged.',
      topics: [
        { q: 'How do I build an audience?', steps: ['Pick a segment — read, replied, ignored, undelivered.', 'Preview the list, then create a campaign for just them.'], find: ['segment', 'create campaign'] }
      ]
    },
    tourpackages: {
      title: 'Packages', icon: '🧳',
      intro: 'Build reusable holiday package templates.',
      topics: [
        { q: 'How do I build a package?', steps: ['Open a package and add day-by-day items, or reuse blocks from the Component Library.'], find: ['add day', 'component'] }
      ]
    },
    admin: {
      title: 'Settings', icon: '⚙️',
      intro: 'Configure your CRM.',
      topics: [
        { q: 'How do I add a team member?', steps: ['Open Users & roles → Add user → set the role → Save.'], find: ['add user', 'user'] },
        { q: 'How do I set up the AI bot?', steps: ['Go to AI Assistant → Bot Settings.'], find: ['bot'] }
      ]
    }
  };
  var ALIASES = { whatsbot: 'whatsbot', aicallSettings: 'admin', settings: 'admin', paymentSettings: 'admin', invSettings: 'admin', aiusage: 'whatsbot' };

  function pageKey() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var seg = h.split(/[\/?]/)[0].toLowerCase() || 'dashboard';
    if (ALIASES[seg]) seg = ALIASES[seg];
    var entry = HELP[seg];
    if (entry && entry.alias) entry = HELP[entry.alias];
    return { seg: seg, entry: entry || null };
  }

  /* ---------- styles ---------- */
  var css = document.createElement('style');
  css.textContent = [
    '#ph-fab{position:fixed;right:16px;bottom:22px;z-index:2147483001;background:#6d28d9;color:#fff;border:2px solid #fff;border-radius:30px;padding:11px 17px;font-size:14px;font-weight:800;box-shadow:0 8px 22px rgba(109,40,217,.55);cursor:pointer;display:flex;gap:6px;align-items:center;font-family:inherit;animation:phpulse 2.4s infinite}',
    '#ph-fab:hover{background:#5b21b6}',
    '@keyframes phpulse{0%{box-shadow:0 6px 18px rgba(109,40,217,.5),0 0 0 0 rgba(109,40,217,.45)}70%{box-shadow:0 6px 18px rgba(109,40,217,.5),0 0 0 12px rgba(109,40,217,0)}100%{box-shadow:0 6px 18px rgba(109,40,217,.5),0 0 0 0 rgba(109,40,217,0)}}',
    '#ph-hint{position:fixed;right:16px;bottom:78px;z-index:2147483001;background:#1f2937;color:#fff;font-size:12.5px;padding:10px 13px;border-radius:11px;max-width:230px;box-shadow:0 10px 30px rgba(0,0,0,.3);cursor:pointer;font-family:inherit;line-height:1.4}',
    '#ph-hint b{color:#c4b5fd}',
    '#ph-hint:after{content:"";position:absolute;right:24px;bottom:-7px;border-left:7px solid transparent;border-right:7px solid transparent;border-top:8px solid #1f2937}',
    '#ph-back{position:fixed;inset:0;background:rgba(15,23,42,.35);z-index:2147483000;opacity:0;pointer-events:none;transition:.2s}',
    '#ph-back.on{opacity:1;pointer-events:auto}',
    '#ph-drawer{position:fixed;top:0;right:0;height:100%;width:370px;max-width:90vw;background:#fff;z-index:2147483002;transform:translateX(100%);transition:.28s;display:flex;flex-direction:column;box-shadow:-14px 0 40px rgba(0,0,0,.18);font-family:inherit}',
    '#ph-drawer.on{transform:none}',
    '.ph-h{background:linear-gradient(135deg,#6d28d9,#7c3aed);color:#fff;padding:15px 16px}',
    '.ph-h .ph-ctx{font-size:11px;opacity:.85;text-transform:uppercase;letter-spacing:.5px}',
    '.ph-h .ph-t{font-size:17px;font-weight:800;margin-top:2px;display:flex;justify-content:space-between;align-items:center}',
    '.ph-h .ph-x{cursor:pointer;font-size:18px;opacity:.9}',
    '.ph-h input{width:100%;margin-top:11px;padding:9px 11px;border:none;border-radius:9px;font-size:13px;box-sizing:border-box}',
    '.ph-body{flex:1;overflow:auto;padding:12px;background:#faf9ff}',
    '.ph-intro{font-size:12.5px;color:#64748b;margin:0 2px 10px}',
    '.ph-topic{border:1px solid #ece9f7;border-radius:12px;margin-bottom:9px;background:#fff;overflow:hidden}',
    '.ph-q{padding:12px 13px;font-size:13.5px;font-weight:700;color:#1e293b;cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center}',
    '.ph-q:hover{background:#faf5ff}',
    '.ph-topic.on .ph-q{color:#6d28d9}',
    '.ph-a{display:none;padding:0 13px 13px}',
    '.ph-topic.on .ph-a{display:block}',
    '.ph-st{display:flex;gap:9px;margin:8px 0;font-size:12.7px;color:#334155;line-height:1.4}',
    '.ph-n{flex:0 0 22px;height:22px;border-radius:50%;background:#6d28d9;color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center}',
    '.ph-show{margin-top:6px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:7px 11px;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;gap:6px;align-items:center}',
    '.ph-none{color:#94a3b8;font-size:12.5px;text-align:center;padding:20px}',
    '.ph-foot{border-top:1px solid #eee;padding:10px 12px;font-size:11.5px;color:#94a3b8;text-align:center}',
    '.ph-hl{outline:3px solid #f59e0b !important;outline-offset:3px;border-radius:8px;transition:.15s}',
    '.ph-tip{position:fixed;z-index:2147483003;background:#1f2937;color:#fff;font-size:12px;padding:7px 11px;border-radius:8px;max-width:220px;box-shadow:0 8px 24px rgba(0,0,0,.3)}',
    '@media(max-width:640px){#ph-fab{bottom:18px;right:14px;padding:11px 16px;font-size:14px}#ph-drawer{width:100vw;max-width:100vw}}'
  ].join('');
  document.head.appendChild(css);

  /* ---------- build DOM ---------- */
  var fab = document.createElement('button');
  fab.id = 'ph-fab'; fab.innerHTML = '❓ <span>Help</span>';
  var back = document.createElement('div'); back.id = 'ph-back';
  var drawer = document.createElement('div'); drawer.id = 'ph-drawer';
  drawer.innerHTML =
    '<div class="ph-h"><div class="ph-ctx" id="ph-ctx">Help</div>' +
    '<div class="ph-t"><span id="ph-title">Help</span><span class="ph-x" id="ph-x">✕</span></div>' +
    '<input id="ph-search" placeholder="🔍 Search this page’s help…"></div>' +
    '<div class="ph-body" id="ph-bodyc"></div>' +
    '<div class="ph-foot">Guides for the page you’re on · tap ❓ any time</div>';

  function mount() {
    if (!document.body) return;
    if (!document.getElementById('ph-fab')) document.body.appendChild(fab);
    if (!document.getElementById('ph-back')) document.body.appendChild(back);
    if (!document.getElementById('ph-drawer')) document.body.appendChild(drawer);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
  // Watchdog: some SPA re-renders can wipe body children — re-attach if the
  // button ever disappears so users never lose access to Help.
  setInterval(mount, 2000);

  // First-visit nudge so users notice the button (shows a few times, then stops).
  function maybeHint() {
    try {
      var n = Number(localStorage.getItem('ph_hint_seen') || '0');
      if (n >= 3) return;
      if (document.getElementById('ph-hint')) return;
      var hint = document.createElement('div');
      hint.id = 'ph-hint';
      hint.innerHTML = '👋 New: tap <b>❓ Help</b> for a quick guide on this page.';
      hint.onclick = function () { hint.remove(); open(); };
      document.body.appendChild(hint);
      localStorage.setItem('ph_hint_seen', String(n + 1));
      setTimeout(function () { var h = document.getElementById('ph-hint'); if (h) h.remove(); }, 8000);
    } catch (_) {}
  }
  setTimeout(maybeHint, 1800);

  var q = ''; // search text
  function render() {
    var pk = pageKey();
    var entry = pk.entry || GENERIC;
    document.getElementById('ph-ctx').textContent = 'Help · ' + (entry.title || 'This page');
    document.getElementById('ph-title').textContent = (entry.icon ? entry.icon + ' ' : '') + (entry.title || 'This page');
    var body = document.getElementById('ph-bodyc');
    var topics = (entry.topics || []).filter(function (t) {
      if (!q) return true;
      var hay = (t.q + ' ' + (t.steps || []).join(' ')).toLowerCase();
      return hay.indexOf(q.toLowerCase()) >= 0;
    });
    var html = entry.intro ? '<div class="ph-intro">' + esc(entry.intro) + '</div>' : '';
    if (!topics.length) html += '<div class="ph-none">No matching help. Try another word, or tap ❓ on a different page.</div>';
    topics.forEach(function (t, i) {
      html += '<div class="ph-topic" data-i="' + i + '"><div class="ph-q">' + esc(t.q) + '<span>⌄</span></div><div class="ph-a">';
      (t.steps || []).forEach(function (s, n) { html += '<div class="ph-st"><div class="ph-n">' + (n + 1) + '</div><div>' + esc(s) + '</div></div>'; });
      if (t.find && t.find.length) html += '<div class="ph-show" data-find="' + esc(t.find.join('||')) + '">🔦 Show me on this page</div>';
      html += '</div></div>';
    });
    body.innerHTML = html;
    // wire accordions
    body.querySelectorAll('.ph-topic').forEach(function (el) {
      el.querySelector('.ph-q').onclick = function () { el.classList.toggle('on'); };
    });
    body.querySelectorAll('.ph-show').forEach(function (el) {
      el.onclick = function (e) { e.stopPropagation(); showMe(el.getAttribute('data-find').split('||')); };
    });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function open() { render(); back.classList.add('on'); drawer.classList.add('on'); }
  function close() { back.classList.remove('on'); drawer.classList.remove('on'); clearHL(); }

  /* ---------- Show me: highlight a control on the CURRENT page ---------- */
  var hlEl = null, tipEl = null;
  function clearHL() { if (hlEl) { hlEl.classList.remove('ph-hl'); hlEl = null; } if (tipEl) { tipEl.remove(); tipEl = null; } }
  function showMe(hints) {
    clearHL();
    // Only real actionable controls — buttons/links/tabs/nav — NOT labels,
    // inputs or table headers (that's what made it hit "Save default" or the
    // "RECENT REMARK" column header). Score matches so exact/prefix on a short
    // label wins over a loose substring in some long text.
    var cands = Array.prototype.slice.call(document.querySelectorAll('button, a[href], [role="button"], .btn, [data-view], nav a, .nav-item, .tab'));
    var best = null, bestScore = -1;
    for (var hi = 0; hi < hints.length; hi++) {
      var hint = String(hints[hi] || '').toLowerCase().trim();
      if (!hint) continue;
      var esc = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var wordRe = new RegExp('(^|[\\s+·:])' + esc + '([\\s+·:!?]|$)');
      for (var ci = 0; ci < cands.length; ci++) {
        var el = cands[ci];
        if (el === fab || drawer.contains(el)) continue;
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
        var t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!t || t.length > 46) continue;
        var score = -1;
        if (t === hint) score = 100;
        else if (t.indexOf(hint) === 0) score = 82;
        else if (wordRe.test(t)) score = 64;
        else if (t.indexOf(hint) >= 0) score = 24;
        if (score >= 0) {
          score += Math.max(0, 18 - t.length);
          score += (hints.length - hi) * 2;
          if (score > bestScore) { bestScore = score; best = el; }
        }
      }
      if (best && bestScore >= 82) break;
    }
    // On small screens, close the drawer so the control is visible.
    if (window.innerWidth <= 640) close();
    if (!best) { toast('That control isn’t on this screen right now — follow the steps above.'); return; }
    var found = best;
    found.classList.add('ph-hl'); hlEl = found;
    try { found.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
    var r = found.getBoundingClientRect();
    tipEl = document.createElement('div'); tipEl.className = 'ph-tip';
    tipEl.textContent = '👆 This is it';
    tipEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 150)) + 'px';
    tipEl.style.top = (r.bottom + 8) + 'px';
    document.body.appendChild(tipEl);
    setTimeout(clearHL, 3600);
  }
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'ph-tip';
    t.style.left = '50%'; t.style.top = '20px'; t.style.transform = 'translateX(-50%)';
    t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }

  /* ---------- wire events ---------- */
  fab.onclick = open;
  drawer.addEventListener('click', function (e) { if (e.target && e.target.id === 'ph-x') close(); });
  back.onclick = close;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  drawer.addEventListener('input', function (e) { if (e.target && e.target.id === 'ph-search') { q = e.target.value; render(); } });
  // keep drawer in sync if the user navigates while it's open
  window.addEventListener('hashchange', function () { if (drawer.classList.contains('on')) { q = ''; var s = document.getElementById('ph-search'); if (s) s.value = ''; render(); } });
})();
