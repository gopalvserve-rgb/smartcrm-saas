/* ============================================================
 * DEMO_TOUR_v3 — Live guided sales tour on the showcase tenant
 * ------------------------------------------------------------
 * Guided walkthrough that steps a salesperson through the
 * SmartCRM pitch — ON THE REAL APP, in Hinglish, in the EXACT
 * 15-step pitch-script order. At every mobile-notification
 * moment it shows a realistic phone screen.
 *
 * GATED: launch button only shows for slug "vserve" (showcase
 * account), or ?demotour=1, or localStorage.demoTour==="1".
 * cache key: 2026-06-29-demotour-v3
 * ============================================================ */
(function () {
  'use strict';

  function enabled() {
    try {
      var qs = new URLSearchParams(location.search);
      if (qs.get('demotour') === '1') return true;
      if (localStorage.getItem('demoTour') === '1') return true;
      if (String(window.TENANT_SLUG || '').toLowerCase() === 'vserve') return true;
    } catch (_) {}
    return false;
  }
  if (!enabled()) return;

  var TOUR = [
    { intro: true, title: 'Opening — Qualification', en: 'First call & qualify the lead',
      s: 'Sir, aapne Smart CRM ke liye apna number register kiya tha. — (Customer: Yes) — Sir, kitne employees ke liye chahiye? (Customer: 3). Theek hai sir, abhi available hain to main aapko Google Meet par live demo de deta hoon.' },

    { navId: 'leads', hash: '#/leads', title: 'Lead Capture', en: 'All sources in one inbox',
      s: 'Sir ismein lead sabhi sources se ek hi jagah aa jaati hai — WhatsApp, Facebook Ad, Instagram Ad, Google Ad, Website, Google Sheet, IndiaMART, JustDial. Sab ek hi inbox mein.' },

    { navId: 'admin', hash: '#/admin', title: 'Auto-Assignment + Auto-Dial', en: 'Lead distributed -> phone notification -> one-tap call',
      s: 'Lead aate hi system use khud team member ko assign kar deta hai — campaign, source ya product, jo bhi rule banayein. Jaise hi lead assign hoti hai, team member ke MOBILE par notification aata hai, aur auto-dial ka option milta hai — agent OK kare, ek tap mein call connect.',
      phone: { type: 'assigncall', name: 'Rahul Sharma', sub: 'Solar enquiry · Google Ad', note: 'New Lead Assigned',
               cap: 'Agent ke phone par: notification + auto-dial' } },

    { navId: 'tatreport', hash: '#/tatreport', title: 'TAT / SLA', en: 'Response-time escalation alerts',
      s: 'Yahan TAT set karte hain — jaise nayi lead ko 15 min mein call karna hai. Agar agent 15 min mein call nahi karta to use TAT violation ka message jaata hai. System phir 15 min wait karta hai — phir bhi nahi, to agent + manager ko; agle level par next agent + manager + admin tak escalate hota hai.',
      phone: { type: 'stack', cap: 'Phone par escalation aise aata hai', items: [
        { ico: '!', tone: 'warn',   app: 'Smart CRM · TAT', title: 'TAT Violation', body: 'Rahul Sharma · 15 min mein call nahi hui', time: 'now' },
        { ico: '!', tone: 'orange', app: 'Smart CRM · TAT', title: 'Escalation L1', body: 'Agent + Manager ko notify kiya', time: '15m' },
        { ico: '!', tone: 'red',    app: 'Smart CRM · TAT', title: 'Escalation L2', body: 'Next Agent + Manager + Admin', time: '30m' } ] } },

    { navId: 'whatsbot', hash: '#/whatsbot', title: 'Auto Communication', en: 'WhatsApp + Email on every new lead',
      s: 'Jaise hi nayi lead aati hai, system se WhatsApp API ke through WhatsApp message aur Email — dono automatically chale jaate hain.' },

    { navId: 'aibot', hash: '#/aibot', title: 'AI Bot — Hot Lead Alert', en: '24x7 auto-handling -> hot-lead notification',
      s: 'WhatsApp par AI Bot activate kar dein to system khud customer se baat karta hai — appointment booking, product filtration, requirement samajhna. Bas bot ko website ya product brochure de dein; ye 24 ghante saari chats handle karta hai. Customer qualify hote hi aapko Hot Lead ka notification aata hai aur lead par uski poori requirement note ho jaati hai.',
      phone: { type: 'push', ico: '🔥', app: 'Smart CRM · AI Bot', title: 'Hot Lead Qualified', body: 'Rahul Sharma · 5kW solar · Budget ready · Book demo', time: 'now',
               cap: 'Owner ke phone par hot-lead alert' } },

    { navId: 'callinsights', hash: '#/callinsights', title: 'Call Intelligence', en: 'Recording + AI audit',
      s: 'Aapki team jo bhi baat karti hai, har call record hoti hai — self audit bhi kar sakte hain aur AI Audit feature bhi hai. AI har call ki transcription, positive/negative tone aur saare important facts bata deta hai. Saath hi caller-wise rating bhi milti hai — kis caller ki kitni rating hai.' },

    { navId: 'quotations', hash: '#/quotations', title: 'Manual Outreach', en: 'WhatsApp templates + quotation',
      s: 'Yahin se customer ko manual WhatsApp bhej sakte hain — personal number se bhi aur official WhatsApp API template se bhi (personal ke liye bhi template ban jaata hai). Aur isi jagah se customer ko quotation bhi ek click mein bhej dein.' },

    { navId: 'admin', hash: '#/admin', title: 'Customization + Follow-up Reminder', en: 'Custom status/fields + reminder notification',
      s: 'Ye status aur fields jo aap dekh rahe hain, sab customized hain — apne hisaab se banayein. Yahin follow-up reminder lagayein; jis time ka reminder lagayenge, us time agent ke MOBILE aur system — dono par notification aa jaata hai. Upar dashboard par dikhta hai — kitne upcoming, kitne due today, kitne overdue.',
      phone: { type: 'push', ico: '⏰', app: 'Smart CRM', title: 'Follow-up Reminder', body: 'Call Priya Mehta · Due 4:30 PM today', time: 'now', call: true,
               cap: 'Agent ke phone par reminder' } },

    { navId: 'whatsbot', hash: '#/whatsbot', title: 'Nurturing — Bot Reminds the Lead', en: 'Drip reminders sent to the lead on WhatsApp',
      s: 'Lead nurturing bhi hai — aaj aayi lead ko 3 din baad kya bhejna hai, 5 din baad kya, 7 din baad kya — alag-alag conditions ke saath. Ek baar set karein, system khud lead ko WhatsApp par reminder bhejta rahega.',
      phone: { type: 'whatsapp', name: 'Sunrise Solar', sub: 'Business · online', cap: 'Lead ke phone par bot ka reminder', msgs: [
        { text: 'Hi Priya 👋 3 din pehle aapne solar ke liye enquiry ki thi. Aaj special — 5kW system par ₹15,000 off!', time: '10:30' },
        { text: 'Demo book karne ke liye yahan reply karein 📞', time: '10:30' } ] } },

    { navId: 'projects', hash: '#/projects', title: 'Post-Sale Stages', en: 'Work after the deal closes',
      s: 'Close ke baad bhi kaam hota hai — token amount par close hua, phir paper collection, 10% payment, delivery stage. Apne hisaab se stages banayein; agent har stage update kare aur follow-up kare ki kaunsa customer kis stage par hai.' },

    { navId: 'reports', hash: '#/reports', title: 'Reporting', en: 'Pipeline + custom report builder',
      s: 'Pipeline tab par stage-wise leads — kitne Qualified, kitne Proposal, kitne Won. User, manager, product, source aur campaign wise filter. Custom report builder bhi hai — ek baar save karein, hamesha dekhein; chahein to har shaam complete report email par bhi aa jaaye.' },

    { navId: 'callactivity', hash: '#/callactivity', title: 'Call & Activity Reports', en: 'Caller + activity + WhatsApp reporting',
      s: 'Call activity mein caller-wise poori reporting — outgoing calls, talk-time, saari detail. Activity report mein touch-points aur data-points, aur saath hi WhatsApp reporting ka pura detail bhi.' },

    { navId: 'attendance', hash: '#/attendance', title: 'HR Module', en: 'Attendance, leave & salary',
      s: 'HR module bhi hai — employee attendance laga sakte hain with time, date, location, device aur map view. Team yahin se leave apply kare, manager approve/disapprove kare. Month end par system attendance aur leave ke hisaab se salary auto-calculate kar deta hai.' },

    { navId: 'invDashboard', hash: '#/invDashboard', title: 'Invoicing & GST', en: 'GST invoice + GSTR-1',
      s: 'Aur ismein Invoicing bhi hai — GST invoice banayein, payment record karein, aur GSTR-1 download karke as-it-is apne accountant ko de dein.' }
  ];

  var css = ''
    + '#dtLaunch{position:fixed;right:18px;bottom:18px;z-index:99990;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;border:0;border-radius:30px;padding:12px 20px;font:600 14px/1 Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(79,70,229,.4)}'
    + '#dtLaunch:hover{filter:brightness(1.07)}'
    + '#dtRing{position:fixed;z-index:99991;border:3px solid #6366f1;border-radius:12px;box-shadow:0 0 0 9999px rgba(15,23,42,.55);pointer-events:none;transition:all .28s cubic-bezier(.2,.9,.3,1.1);display:none}'
    + '#dtCoach{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(180%);width:min(780px,95vw);z-index:99993;background:#0f172a;color:#fff;border:1px solid #334155;border-radius:16px;box-shadow:0 16px 50px rgba(0,0,0,.45);padding:16px 20px;font:14px/1.55 Segoe UI,system-ui,sans-serif;transition:transform .35s cubic-bezier(.2,.9,.3,1.2);max-height:86vh;overflow:auto}'
    + '#dtCoach.show{transform:translateX(-50%) translateY(0)}'
    + '#dtCoach .h{display:flex;align-items:center;gap:10px;margin-bottom:10px}'
    + '#dtCoach .step{background:#6366f1;font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;white-space:nowrap}'
    + '#dtCoach .ttl{font-weight:700;font-size:15px}'
    + '#dtCoach .body{display:flex;gap:16px;align-items:flex-start}'
    + '#dtCoach .scr{flex:1;background:#fff7ed;color:#7c2d12;border-left:4px solid #f59e0b;border-radius:10px;padding:11px 14px;font-weight:600}'
    + '#dtCoach .en{color:#94a3b8;font-size:12px;margin-top:9px}'
    + '#dtCoach .cf{display:flex;align-items:center;gap:8px;margin-top:13px}'
    + '#dtCoach .prog{flex:1;height:6px;background:#1e293b;border-radius:4px;overflow:hidden}'
    + '#dtCoach .prog>span{display:block;height:100%;background:linear-gradient(90deg,#6366f1,#06b6d4);transition:width .3s}'
    + '#dtCoach button{border:0;border-radius:9px;padding:8px 16px;font-weight:700;font-size:13px;cursor:pointer}'
    + '#dtCoach .nxt{background:#6366f1;color:#fff}#dtCoach .nxt:hover{background:#4f46e5}'
    + '#dtCoach .prv{background:#1e293b;color:#cbd5e1}#dtCoach .xit{background:transparent;color:#64748b}'
    + '#dtCoach .kbd{margin-left:auto;color:#64748b;font-size:11px}'
    + '#dtCoach .kbd b{color:#cbd5e1;background:#1e293b;border-radius:5px;padding:1px 6px;font-weight:700}'
    + '.dtPhone{flex-shrink:0;width:172px}'
    + '.dtPhone .frame{background:#000;border-radius:24px;padding:9px 7px 13px;box-shadow:0 12px 28px rgba(0,0,0,.55);border:1px solid #1f2937}'
    + '.dtPhone .scrn{background:linear-gradient(165deg,#1e293b,#0b1220);border-radius:17px;padding:8px 7px 12px;min-height:188px;position:relative;overflow:hidden}'
    + '.dtPhone .notch{width:56px;height:5px;background:#000;border-radius:5px;margin:1px auto 7px}'
    + '.dtPhone .time{color:#e2e8f0;font:800 14px/1 Segoe UI,system-ui;text-align:center}'
    + '.dtPhone .date{color:#94a3b8;font:600 9px/1 Segoe UI,system-ui;text-align:center;margin:2px 0 9px}'
    + '.dtPhone .cap{color:#94a3b8;font:700 9px/1.3 Segoe UI,system-ui;text-align:center;margin-top:8px}'
    + '.dtPush{display:flex;gap:8px;background:rgba(255,255,255,.97);border-radius:12px;padding:8px 9px;box-shadow:0 4px 12px rgba(0,0,0,.35);animation:dtPop .45s cubic-bezier(.2,.9,.3,1.3)}'
    + '.dtPush+.dtPush{margin-top:7px}'
    + '@keyframes dtPop{0%{transform:translateY(-12px) scale(.93);opacity:0}100%{transform:none;opacity:1}}'
    + '.dtPush .ico{flex-shrink:0;width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font:800 12px/26px Segoe UI,system-ui;text-align:center}'
    + '.dtPush.warn .ico{background:#f59e0b}.dtPush.orange .ico{background:#ea580c}.dtPush.red .ico{background:#dc2626}'
    + '.dtPush .tx{flex:1;min-width:0}'
    + '.dtPush .top{display:flex;justify-content:space-between;color:#64748b;font:700 9px/1 Segoe UI,system-ui;margin-bottom:2px}'
    + '.dtPush .ti{color:#0f172a;font:800 11px/1.25 Segoe UI,system-ui;margin-bottom:2px}'
    + '.dtPush .bo{color:#334155;font:600 10px/1.3 Segoe UI,system-ui}'
    + '.dtPush .cta{margin-top:7px;display:flex;gap:5px}'
    + '.dtPush .cta span{flex:1;text-align:center;font:800 9px/1 Segoe UI,system-ui;padding:5px 0;border-radius:6px}'
    + '.dtPush .cta .a{background:#16a34a;color:#fff}.dtPush .cta .b{background:#e2e8f0;color:#475569}'
    + '.dtCall{margin-top:9px;display:flex;flex-direction:column;align-items:center;text-align:center;background:rgba(2,6,23,.35);border:1px solid #1f2937;border-radius:14px;padding:12px 8px 10px}'
    + '.dtCall .av{width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#22c55e,#15803d);color:#fff;font:800 16px/46px Segoe UI,system-ui;text-align:center}'
    + '.dtCall .nm{color:#fff;font:800 12px/1.2 Segoe UI,system-ui;margin-top:7px}'
    + '.dtCall .ds{color:#94a3b8;font:600 9px/1.2 Segoe UI,system-ui;margin-top:2px}'
    + '.dtCall .st{color:#86efac;font:800 9px/1 Segoe UI,system-ui;margin-top:6px;letter-spacing:.4px}'
    + '.dtCall .btns{display:flex;gap:20px;margin-top:9px}'
    + '.dtCall .b{width:34px;height:34px;border-radius:50%;font:15px/34px Segoe UI;text-align:center;color:#fff}'
    + '.dtCall .ans{background:#22c55e;animation:dtRingg 1s infinite}.dtCall .dec{background:#ef4444}'
    + '@keyframes dtRingg{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}50%{box-shadow:0 0 0 7px rgba(34,197,94,0)}}'
    + '.dtWa{border-radius:11px;overflow:hidden;border:1px solid #0b3b32}'
    + '.dtWa .hd{display:flex;align-items:center;gap:7px;background:#075e54;padding:7px 8px}'
    + '.dtWa .hd .av{width:24px;height:24px;border-radius:50%;background:#25d366;color:#053b30;font:800 10px/24px Segoe UI;text-align:center}'
    + '.dtWa .hd .nm{color:#fff;font:800 10px/1.1 Segoe UI,system-ui}'
    + '.dtWa .hd .pr{color:#b9f6ca;font:600 8px/1.1 Segoe UI,system-ui;margin-top:1px}'
    + '.dtWa .wb{background:#0b141a;padding:8px 7px;display:flex;flex-direction:column;gap:6px}'
    + '.dtWa .bin{align-self:flex-start;max-width:90%;background:#1f2c33;color:#e9edef;border-radius:9px 9px 9px 2px;padding:6px 8px 5px;font:600 9.5px/1.35 Segoe UI,system-ui}'
    + '.dtWa .bin .tm{display:block;color:#8aa0ab;font:600 7.5px/1 Segoe UI;text-align:right;margin-top:3px}'
    + '@media(max-width:860px){#dtRing{display:none!important}#dtCoach .body{flex-direction:column;align-items:stretch}.dtPhone{align-self:center}}';
  var styleEl = document.createElement('style'); styleEl.textContent = css; document.head.appendChild(styleEl);

  var launch = document.createElement('button');
  launch.id = 'dtLaunch'; launch.textContent = '▶ Demo Tour';
  var ring = document.createElement('div'); ring.id = 'dtRing';
  var coach = document.createElement('div'); coach.id = 'dtCoach';
  coach.innerHTML =
    '<div class="h"><span class="step" id="dtStep"></span><span class="ttl" id="dtTitle"></span></div>'
    + '<div class="body"><div class="scr" id="dtScript"></div><div id="dtPhone"></div></div>'
    + '<div class="en" id="dtEn"></div>'
    + '<div class="cf"><div class="prog"><span id="dtProg"></span></div>'
    + '<button class="xit" id="dtExit">Exit</button>'
    + '<button class="prv" id="dtPrev">‹ Back</button>'
    + '<button class="nxt" id="dtNext">Next ›</button>'
    + '<span class="kbd"><b>Tab</b> next · <b>Esc</b> exit</span></div>';

  function mount() {
    if (!document.body) { return setTimeout(mount, 300); }
    document.body.appendChild(launch);
    document.body.appendChild(ring);
    document.body.appendChild(coach);
    launch.addEventListener('click', start);
    coach.querySelector('#dtNext').addEventListener('click', next);
    coach.querySelector('#dtPrev').addEventListener('click', prev);
    coach.querySelector('#dtExit').addEventListener('click', end);
  }
  mount();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/);
    return ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '');
  }
  function pushCard(o) {
    var cta = o.call
      ? '<div class="cta"><span class="a">📞 Call</span><span class="b">Later</span></div>' : '';
    return '<div class="dtPush ' + esc(o.tone || '') + '">'
      + '<div class="ico">' + esc(o.ico || 'CRM') + '</div>'
      + '<div class="tx">'
      + '<div class="top"><span>' + esc(o.app || 'Smart CRM') + '</span><span>' + esc(o.time || 'now') + '</span></div>'
      + '<div class="ti">' + esc(o.title) + '</div>'
      + '<div class="bo">' + esc(o.body) + '</div>'
      + cta + '</div></div>';
  }
  function phoneHTML(p) {
    var inner = '';
    if (p.type === 'assigncall') {
      inner = pushCard({ ico: '📥', app: 'Smart CRM', title: p.note || 'New Lead Assigned', body: esc(p.name) + ' · Tap to call', time: 'now' })
        + '<div class="dtCall">'
        + '<div class="av">' + esc(initials(p.name).toUpperCase()) + '</div>'
        + '<div class="nm">' + esc(p.name) + '</div>'
        + '<div class="ds">' + esc(p.sub || '') + '</div>'
        + '<div class="st">● AUTO-DIALING…</div>'
        + '<div class="btns"><span class="b dec">✕</span><span class="b ans">📞</span></div>'
        + '</div>';
    } else if (p.type === 'stack') {
      inner = (p.items || []).map(pushCard).join('');
    } else if (p.type === 'whatsapp') {
      inner = '<div class="dtWa"><div class="hd">'
        + '<div class="av">' + esc(initials(p.name).toUpperCase()) + '</div>'
        + '<div><div class="nm">' + esc(p.name) + '</div><div class="pr">' + esc(p.sub || 'online') + '</div></div>'
        + '</div><div class="wb">'
        + (p.msgs || []).map(function (m) {
            return '<div class="bin">' + esc(m.text) + '<span class="tm">' + esc(m.time || '') + ' ✓✓</span></div>';
          }).join('')
        + '</div></div>';
    } else {
      inner = pushCard(p);
    }
    var cap = p.cap ? '<div class="cap">↑ ' + esc(p.cap) + '</div>' : '';
    return '<div class="dtPhone"><div class="frame"><div class="scrn">'
      + '<div class="notch"></div>'
      + '<div class="time">9:41</div><div class="date">Mobile App · live</div>'
      + inner
      + '</div></div>' + cap + '</div>';
  }

  var i = -1;

  function start() { i = 0; coach.classList.add('show'); show(); }

  function show() {
    var t = TOUR[i];
    if (t.hash && location.hash !== t.hash) { try { location.hash = t.hash; } catch (_) {} }
    coach.querySelector('#dtStep').textContent = 'Step ' + (i + 1) + ' / ' + TOUR.length;
    coach.querySelector('#dtTitle').textContent = t.title;
    coach.querySelector('#dtScript').textContent = t.s;
    coach.querySelector('#dtEn').textContent = '💡 ' + t.en;
    coach.querySelector('#dtPhone').innerHTML = t.phone ? phoneHTML(t.phone) : '';
    coach.querySelector('#dtProg').style.width = ((i + 1) / TOUR.length * 100) + '%';
    coach.querySelector('#dtPrev').style.visibility = (i === 0) ? 'hidden' : 'visible';
    coach.querySelector('#dtNext').textContent = (i === TOUR.length - 1) ? 'Finish ✓' : 'Next ›';
    if (t.navId) placeRing(t.navId, 0);
    else ring.style.display = 'none';
  }

  function placeRing(navId, tries) {
    var el = document.querySelector('.nav a[data-view="' + navId + '"]')
          || document.querySelector('a[data-view="' + navId + '"]')
          || document.querySelector('[data-view="' + navId + '"]');
    if (el) {
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
      var r = el.getBoundingClientRect();
      ring.style.display = 'block';
      ring.style.top = (r.top - 4) + 'px';
      ring.style.left = (r.left - 4) + 'px';
      ring.style.width = (r.width + 8) + 'px';
      ring.style.height = (r.height + 8) + 'px';
    } else if (tries < 12) {
      setTimeout(function () { placeRing(navId, tries + 1); }, 200);
    } else {
      ring.style.display = 'none';
    }
  }

  function next() { if (i >= TOUR.length - 1) { end(); return; } i++; show(); }
  function prev() { if (i > 0) { i--; show(); } }
  function end() {
    i = -1;
    coach.classList.remove('show');
    ring.style.display = 'none';
  }

  function reflow() { if (i >= 0 && TOUR[i].navId) placeRing(TOUR[i].navId, 11); }
  window.addEventListener('resize', reflow);
  window.addEventListener('scroll', reflow, true);

  document.addEventListener('keydown', function (e) {
    if (i < 0) return;
    if (e.key === 'Tab') { e.preventDefault(); if (e.shiftKey) prev(); else next(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    else if (e.key === 'Escape') end();
  });

  window.SmartCRMDemoTour = { start: start, end: end, steps: TOUR };
})();
