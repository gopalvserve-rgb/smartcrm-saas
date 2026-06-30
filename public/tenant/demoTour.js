/* ============================================================
 * DEMO_TOUR_v15 — Live guided sales tour on the showcase tenant
 * ------------------------------------------------------------
 * 25-step pitch flow (Hinglish) on the REAL app, EXACT routes the
 * user mapped. Two draggable + resizable floating panels: TEXT
 * coach (bottom-left) + bigger MOBILE-SCREEN panel (right).
 * Highlight ring stays visible; nothing dims the screen.
 *
 * GATED: launch button only shows for slug "showcase", or
 * ?demotour=1, or localStorage.demoTour==="1".
 * cache key: 2026-06-29-demotour-v15
 * ============================================================ */
(function () {
  'use strict';

  var ASSET_V = '2026-06-29-demotour-v15';

  function enabled() {
    try {
      var qs = new URLSearchParams(location.search);
      if (qs.get('demotour') === '1') return true;
      if (localStorage.getItem('demoTour') === '1') return true;
      if (String(window.TENANT_SLUG || '').toLowerCase() === 'showcase') return true;
    } catch (_) {}
    return false;
  }
  if (!enabled()) return;

  var NOTIF = 'demo-mob-notif.jpg';
  var LEADS = 'demo-mob-leads.jpg';

  var TOUR = [
    { hash: '#/dashboard', title: 'Opening — Dashboard', en: 'Qualify, then open the dashboard',
      s: 'Sir, aapne Smart CRM ke liye number register kiya tha — kitne employees ke liye chahiye? Chaliye live demo dekhte hain. Ye raha aapka dashboard — poora business ek hi nazar mein.' },

    { navId: 'leads', hash: '#/leads', title: 'Lead Capture', en: 'All sources in one inbox',
      s: 'Lead sabhi sources se ek hi jagah aa jaati hai — WhatsApp, Facebook Ad, Instagram Ad, Google Ad, Website, Google Sheet, IndiaMART, JustDial. Sab ek hi inbox mein.',
      img: { src: 'demo-leadcapture.svg', cap: 'Auto lead capture — all sources (representation)', wide: true } },

    { navId: 'leads', hash: '#/leads', title: 'Auto-Assignment + Auto-Dial', en: 'Lead distributed -> phone notification -> one-tap call',
      s: 'Lead aate hi system khud team member ko assign kar deta hai — campaign, source ya product rule par. Assign hote hi agent ke MOBILE par notification aata hai aur auto-dial — ek tap mein call connect.',
      img: { src: 'demo-autodial.svg', cap: 'Auto-dial queue agent ke phone par' } },

    { hash: '#/tatreport', title: 'TAT / SLA', en: 'Response-time escalation alerts',
      s: '15 min mein call ka TAT set karein. Na ho to agent ko violation; phir agent + manager; phir next agent + manager + admin tak escalate — sab phone notification par.',
      img: { src: 'demo-tat.svg', cap: 'TAT violations agent ke phone par' } },

    { navId: 'whatsbot', hash: '#/whatsbot/chat', title: 'Auto Communication', en: 'WhatsApp + Email on every new lead',
      s: 'Jaise hi nayi lead aati hai, WhatsApp API se WhatsApp message aur Email — dono automatically chale jaate hain.' },

    { navId: 'leads', hash: '#/leads', title: 'AI Bot — Hot Lead Alert', en: '24x7 auto-handling -> hot-lead notification',
      s: 'AI Bot WhatsApp par khud baat karta hai — appointment, product filtration, requirement. 24 ghante chats handle, qualify hote hi aapko Hot Lead notification aur lead par poori requirement note.',
      img: { src: NOTIF, cap: 'Hot-lead alert phone par' } },

    { navId: 'leads', hash: '#/leads', title: 'Call Intelligence', en: 'Recording + AI audit',
      s: 'Har call record hoti hai — self audit aur AI Audit dono. AI transcription, positive/negative tone, important facts aur caller-wise rating deta hai.' },

    { navId: 'leads', hash: '#/leads', title: 'Manual Outreach', en: 'WhatsApp templates + quotation',
      s: 'Yahin se manual WhatsApp — personal number se bhi, official API template se bhi. Quotation bhi yahin se ek click mein.' },

    { navId: 'followups', hash: '#/followups', title: 'Customization + Follow-up Reminder', en: 'Custom status/fields + reminder notification',
      s: 'Status aur fields sab customized. Follow-up reminder lagayein — us time agent ke MOBILE aur system, dono par notification. Dashboard par upcoming, due today, overdue dikhta hai.',
      img: { src: NOTIF, cap: 'Follow-up reminder phone par' } },

    { navId: 'admin', hash: '#/admin', title: 'Nurturing', en: 'Drip engagement over days',
      s: 'Lead nurturing — aaj ki lead ko 3 din, 5 din, 7 din baad kya bhejna hai, alag conditions ke saath. Ek baar set karein, system matching data bhejta rahega.',
      img: { src: 'demo-nurturing.svg', cap: 'Status + day-wise nurturing journey (representation)', wide: true } },

    { navId: 'leads', hash: '#/leads', title: 'AI — Lead AI Summary', en: 'Auto summary of every lead',
      s: 'Har lead ka AI chhota summary bana deta hai — pichhli baat-cheet, requirement aur next step ek nazar mein. Agent ko poori history padhne ki zaroorat nahi.' },

    { navId: 'leads', hash: '#/leads', title: 'AI Lead Rating — Hot / Warm / Nurture / Cold', en: 'AI scores each lead into buckets',
      s: 'AI har lead ko khud rate karta hai — Hot, Warm, Nurture ya Cold. Engagement, replies aur activity dekh kar bucket assign hota hai, taaki team pehle Hot leads par focus kare.' },

    { navId: 'leads', hash: '#/leads', title: 'AI — Auto Update Status, Time & Remark', en: 'AI updates the lead automatically',
      s: 'Call ke baad AI khud lead ka status, follow-up time aur remark update kar deta hai — agent ko manually likhna nahi padta, data hamesha updated rehta hai.' },

    { hash: '#/projects', title: 'Post-Sale Stages', en: 'Work after the deal closes',
      s: 'Close ke baad bhi kaam — token amount, paper collection, 10% payment, delivery. Apne stages banayein; agent har stage update aur follow-up kare.' },

    { navId: 'reports', hash: '#/reports', title: 'Reporting', en: 'Pipeline + custom report builder',
      s: 'Stage-wise leads — Qualified, Proposal, Won. User / manager / product / source / campaign filter. Custom report builder + har shaam complete report email par.' },

    { hash: '#/callactivity', title: 'Call & Activity Reports', en: 'Caller-wise call reporting',
      s: 'Caller-wise call reporting — outgoing, incoming, missed aur talk-time, saari detail. Daily call activity ek hi jagah.' },

    { hash: '#/activityreport', title: 'Lead Activity Report', en: 'What each employee actually did',
      s: 'Yahan dekh sakte hain aapke employee ne kitne number edit kiye, kitne follow-up update kiye, kitne remark add kiye, kitni leads par NP (not picked) kiya. Daily aur weekly report bhi mil jaati hai.' },

    { hash: '#/whatsappreport', title: 'WhatsApp Activity Report', en: 'Sent / opened / failed + button clicks',
      s: 'Yahan dekh sakte hain kitni leads par WhatsApp gaya, kitne open hue, kitne fail hue. Saath hi kitne button-click aaye aur kaunse users ne kiya — poori detail.' },

    { navId: 'knowledge', hash: '#/knowledge', title: 'Knowledge Base', en: 'Scripts, price list, brochures',
      s: 'Yahan caller ki script, price list, brochure aur baaki saari sales-related cheezein rehti hain — poori team ko ek hi jagah sab mil jaata hai.' },

    { hash: '#/tasks', title: 'Task Management', en: 'Assign tasks, track daily work',
      s: 'Employee apna din ka kaam yahan submit karte hain. Aap task assign kar sakte hain aur progress + report dono dekh sakte hain.' },

    { hash: '#/attendance', title: 'Attendance', en: 'Time, location, device, map',
      s: 'Attendance — time, date, location, device aur map view. Employee yahin se punch karte hain.' },

    { hash: '#/tracking', title: 'Location Tracking', en: 'Live field-team location',
      s: 'Field team ki live location tracking — kaun kahan hai, din bhar ka movement map par dikh jaata hai.' },

    { hash: '#/leaves', title: 'Leaves', en: 'Apply, approve, auto-salary',
      s: 'Team yahin se leave apply kare; manager approve/disapprove kare. Month end par attendance + leave ke hisaab se salary auto-calculate.' },

    { hash: '#/invDashboard', title: 'Invoicing & GST', en: 'GST invoice + GSTR-1',
      s: 'GST invoice banayein, payment record karein, aur GSTR-1 download karke as-it-is accountant ko de dein.' },

    { title: 'Co-Pilot', en: 'Your AI assistant inside the CRM',
      s: 'Co-Pilot — aapka AI assistant. Plain language mein poochein — "aaj ki hot leads dikhao", "is lead ka follow-up laga do", "kal ka report bhejo" — aur Co-Pilot kaam kar deta hai. Reports, summaries aur actions, sab chat se.' }
  ];

  var css = ''
    + '#dtLaunch{position:fixed;right:18px;bottom:18px;z-index:99990;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;border:0;border-radius:30px;padding:11px 18px;font:600 13px/1 Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(79,70,229,.4)}'
    + '#dtLaunch:hover{filter:brightness(1.07)}'
    + '#dtRing{position:fixed;z-index:99991;border:3px solid #6366f1;border-radius:10px;box-shadow:0 0 0 2px rgba(99,102,241,.35),0 0 16px 4px rgba(99,102,241,.5);pointer-events:none;transition:all .28s cubic-bezier(.2,.9,.3,1.1);display:none}'
    + '#dtCoach{position:fixed;left:16px;bottom:16px;width:330px;min-width:240px;max-width:620px;min-height:120px;max-height:88vh;z-index:99993;background:rgba(15,23,42,.85);backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px);color:#fff;border:1px solid rgba(148,163,184,.32);border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.4);padding:0 14px 12px;font:13px/1.5 Segoe UI,system-ui,sans-serif;transition:transform .32s cubic-bezier(.2,.9,.3,1.2);transform:translateY(180%);resize:both;overflow:auto}'
    + '#dtCoach.show{transform:translateY(0)}'
    + '#dtCoach .h{display:flex;align-items:center;gap:8px;margin:0 -14px 8px;padding:9px 14px 8px;border-bottom:1px solid rgba(148,163,184,.18);cursor:move;position:sticky;top:0;background:rgba(15,23,42,.6)}'
    + '#dtCoach .grip{color:#64748b;font-size:13px;letter-spacing:-1px}'
    + '#dtCoach .step{background:#6366f1;font-size:10px;font-weight:800;padding:2px 8px;border-radius:20px;white-space:nowrap}'
    + '#dtCoach .ttl{font-weight:700;font-size:13px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '#dtCoach .scr{color:#e5e9f0;font-size:12.5px;line-height:1.55}'
    + '#dtCoach .en{color:#8ea2bd;font-size:11px;margin-top:6px}'
    + '#dtCoach .cf{display:flex;align-items:center;gap:7px;margin-top:11px}'
    + '#dtCoach .prog{flex:1;height:5px;background:#1e293b;border-radius:4px;overflow:hidden}'
    + '#dtCoach .prog>span{display:block;height:100%;background:linear-gradient(90deg,#6366f1,#06b6d4);transition:width .3s}'
    + '#dtCoach button{border:0;border-radius:8px;padding:6px 12px;font-weight:700;font-size:12px;cursor:pointer}'
    + '#dtCoach .nxt{background:#6366f1;color:#fff}#dtCoach .nxt:hover{background:#4f46e5}'
    + '#dtCoach .prv{background:#1e293b;color:#cbd5e1}#dtCoach .xit{background:transparent;color:#7889a3}'
    + '#dtCoach .kbd{margin-left:auto;color:#64748b;font-size:10px}'
    + '#dtCoach .kbd b{color:#cbd5e1;background:#1e293b;border-radius:4px;padding:1px 5px}'
    // ---- mobile-screen panel (right, draggable + resizable) ----
    + '#dtShotPanel{position:fixed;right:18px;top:80px;width:260px;height:430px;min-width:160px;min-height:240px;max-width:600px;max-height:92vh;z-index:99992;display:none;flex-direction:column;background:rgba(15,23,42,.85);backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px);border:1px solid rgba(148,163,184,.32);border-radius:16px;box-shadow:0 12px 38px rgba(0,0,0,.45);padding:8px;resize:both;overflow:hidden}'
    + '#dtShotPanel .hd{display:flex;align-items:center;gap:6px;cursor:move;color:#aebdd2;font:700 10px/1 Segoe UI,system-ui;padding:3px 4px 8px}'
    + '#dtShotPanel .hd .grip{color:#64748b;font-size:13px;letter-spacing:-1px}'
    + '#dtShotPanel .shot{flex:1;min-height:0;width:100%;object-fit:contain;border-radius:11px;background:#0b1220;border:2px solid #0b1220}'
    + '#dtShotPanel .cap{color:#8ea2bd;font:600 10px/1.3 Segoe UI,system-ui;text-align:center;margin-top:7px}'
    + '#dtShotPanel .rsz,#dtCoach .rsz{position:absolute;right:3px;bottom:3px;color:#64748b;font-size:12px;pointer-events:none}'
    + '@media(max-width:600px){#dtRing{display:none!important}#dtCoach{left:8px;right:8px;width:auto}#dtShotPanel{right:8px;width:150px;height:300px}}';
  var styleEl = document.createElement('style'); styleEl.textContent = css; document.head.appendChild(styleEl);

  var launch = document.createElement('button');
  launch.id = 'dtLaunch'; launch.textContent = '▶ Demo Tour';
  var ring = document.createElement('div'); ring.id = 'dtRing';

  var coach = document.createElement('div'); coach.id = 'dtCoach';
  coach.innerHTML =
    '<div class="h" id="dtCoachHandle"><span class="grip">⠿</span><span class="step" id="dtStep"></span><span class="ttl" id="dtTitle"></span></div>'
    + '<div class="scr" id="dtScript"></div>'
    + '<div class="en" id="dtEn"></div>'
    + '<div class="cf"><div class="prog"><span id="dtProg"></span></div>'
    + '<button class="xit" id="dtExit">Exit</button>'
    + '<button class="prv" id="dtPrev">‹</button>'
    + '<button class="nxt" id="dtNext">Next ›</button>'
    + '<span class="kbd"><b>Tab</b> next</span></div>'
    + '<span class="rsz">⤡</span>';

  var shot = document.createElement('div'); shot.id = 'dtShotPanel';
  shot.innerHTML =
    '<div class="hd" id="dtShotHandle"><span class="grip">⠿</span><span id="dtShotLabel">Mobile view — drag / resize</span></div>'
    + '<img class="shot" id="dtShotImg" alt="mobile screen">'
    + '<div class="cap" id="dtShotCap"></div>'
    + '<span class="rsz">⤡</span>';

  function mount() {
    if (!document.body) { return setTimeout(mount, 300); }
    document.body.appendChild(launch);
    document.body.appendChild(ring);
    document.body.appendChild(coach);
    document.body.appendChild(shot);
    launch.addEventListener('click', start);
    coach.querySelector('#dtNext').addEventListener('click', next);
    coach.querySelector('#dtPrev').addEventListener('click', prev);
    coach.querySelector('#dtExit').addEventListener('click', end);
    makeDraggable(coach, coach.querySelector('#dtCoachHandle'));
    makeDraggable(shot, shot.querySelector('#dtShotHandle'));
  }

  function makeDraggable(el, handle) {
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var r = el.getBoundingClientRect();
      var ox = e.clientX - r.left, oy = e.clientY - r.top;
      el.style.left = r.left + 'px'; el.style.top = r.top + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
      if (el === coach) el.style.transform = 'none';
      function mm(ev) {
        var x = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - ox));
        var y = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - oy));
        el.style.left = x + 'px'; el.style.top = y + 'px';
      }
      function mu() { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); }
      document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
    });
  }
  mount();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var i = -1;
  var lastWide = null;

  function start() { i = 0; coach.classList.add('show'); show(); }

  function show() {
    var t = TOUR[i];
    if (t.hash && location.hash !== t.hash) { try { location.hash = t.hash; } catch (_) {} }
    coach.querySelector('#dtStep').textContent = 'Step ' + (i + 1) + ' / ' + TOUR.length;
    coach.querySelector('#dtTitle').textContent = t.title;
    coach.querySelector('#dtScript').textContent = t.s;
    coach.querySelector('#dtEn').textContent = '💡 ' + t.en;
    coach.querySelector('#dtProg').style.width = ((i + 1) / TOUR.length * 100) + '%';
    coach.querySelector('#dtPrev').style.visibility = (i === 0) ? 'hidden' : 'visible';
    coach.querySelector('#dtNext').textContent = (i === TOUR.length - 1) ? 'Finish ✓' : 'Next ›';
    if (t.img) {
      shot.querySelector('#dtShotImg').src = t.img.src + '?v=' + ASSET_V;
      shot.querySelector('#dtShotCap').textContent = t.img.cap || '';
      var wide = !!t.img.wide;
      shot.querySelector('#dtShotLabel').textContent = wide ? 'Reference — drag · resize' : 'Mobile view — drag · resize';
      shot.querySelector('#dtShotImg').style.background = wide ? 'transparent' : '#0b1220';
      shot.querySelector('#dtShotImg').style.border = wide ? '0' : '2px solid #0b1220';
      if (wide !== lastWide) {
        if (wide) { shot.style.width = '540px'; shot.style.height = '380px'; }
        else { shot.style.width = '260px'; shot.style.height = '440px'; }
        lastWide = wide;
      }
      shot.style.display = 'flex';
    } else {
      shot.style.display = 'none';
    }
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
    shot.style.display = 'none';
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
