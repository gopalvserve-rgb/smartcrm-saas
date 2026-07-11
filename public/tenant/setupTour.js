/* ═══════════════════════════════════════════════════════════════════
   SETUP_TOUR_v1 — first-run Setup Guide for a newly-joined tenant.
   Faithful port of SETUP_TOUR_v1_REAL_CRM_MOCKUP.html into the live CRM.

   States (exactly as designed):
     Day-0 welcome modal  →  collapsed rocket badge  ↔  expanded panel
     →  coach-mark spotlight tour over the REAL settings pages
     →  completion card + confetti

   ADMIN ONLY — api_setup_status returns admin:false for every other role.
   Task completion is DATA-DRIVEN (backend inspects real CRM state) and can
   also be set by hand ("✓ Mark Done" / "↻ Reopen").
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__SETUP_TOUR__) return;
  window.__SETUP_TOUR__ = true;

  var api = function () { return window.api.apply(null, arguments); };

  /* ── Coach steps: targets are REAL element ids tagged in app.js ── */
  var COACH = {
    company: {
      route: '#/admin', tab: 'company', videoTitle: 'Video 02 · Products & Config',
      video: 'https://drive.google.com/file/d/1uzkz7Qz9F6nuBL_eVWavKsEqorcHVxHY/view',
      steps: [
        { target: '#st-company-name', title: 'Type your company name',
          desc: 'This appears on invoices, emails and the CRM header.', arrow: 'right' },
        { target: '#st-logo-drop', title: 'Upload your logo',
          desc: 'Drop a PNG or JPG (max 1.5MB). Square logos look best.', arrow: 'right' },
        { target: '#st-save-brand', title: 'Save your changes',
          desc: "Hit Save. That's Task 1 done — brand set up.", arrow: 'up' }
      ]
    },
    statuses: {
      route: '#/admin', tab: 'statuses', videoTitle: 'Video 02 · Statuses & Custom Fields',
      video: 'https://drive.google.com/file/d/1uzkz7Qz9F6nuBL_eVWavKsEqorcHVxHY/view',
      steps: [
        { target: '#st-status-list', title: 'Why statuses matter',
          desc: 'A status is a pipeline stage. New → Contacted → Qualified → Won / Lost is a good starting point.', arrow: 'right' },
        { target: '#st-add-status', title: 'Add your first status',
          desc: 'Give it a name and pick a colour — it shows up as a chip everywhere.', arrow: 'up' },
        { target: '#st-status-list', title: 'Aim for 4–5 statuses',
          desc: 'Build out the stages your team actually uses.', arrow: 'right' }
      ]
    },
    wa: {
      route: '#/whatsbot/connect', tab: null, videoTitle: 'Video 08 · Connect Your WhatsApp',
      video: 'https://drive.google.com/file/d/1JAJY-aJtsT1tzxjxXq_KdbFajfrHrGE5/view',
      steps: [
        { target: '#st-connect-wa', title: 'Click Connect with Facebook',
          desc: 'Sign in with your Facebook business account and pick the WABA you want to link. This is the foundation for every WhatsApp workflow.', arrow: 'up' }
      ]
    },
    fb: {
      route: '#/admin', tab: 'facebook', videoTitle: 'Video 07 · Facebook Lead Ads Connect',
      video: 'https://drive.google.com/file/d/1lKWn5lNRpKHF9fiT34i6pj02DMXXTua2/view',
      steps: [
        { target: '#st-connect-fb', title: 'Click Connect with Facebook',
          desc: 'Grant Lead Ads permission for the pages you run ads on. Every form submission then lands in your pipeline instantly.', arrow: 'up' }
      ]
    }
  };

  var S = { tasks: [], done: 0, total: 4, daysLeft: 10, curTask: null, curStep: 0, booted: false };

  /* ── Styles (ported verbatim from the mockup) ── */
  function injectCss() {
    if (document.getElementById('st-css')) return;
    var css = document.createElement('style');
    css.id = 'st-css';
    css.textContent = [
      ':root{--st-brand:#6366f1;--st-brand-dark:#4338ca;--st-brand-soft:#eef2ff;--st-ok:#10b981;--st-ok-soft:#d1fae5;--st-warn-soft:#fef3c7;--st-bg:#f8fafc;--st-bg-alt:#f1f5f9;--st-border:#e2e8f0;--st-border-light:#f1f5f9;--st-text-soft:#64748b;--st-muted:#94a3b8;}',
      '.st-badge{position:fixed;bottom:22px;right:22px;width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;z-index:9989;box-shadow:0 10px 30px rgba(79,70,229,.45);}',
      '.st-badge .rocket{font-size:20px;line-height:1}.st-badge .count{font-size:10px;font-weight:800;margin-top:1px}',
      '.st-panel{position:fixed;bottom:22px;right:22px;width:350px;background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(15,23,42,.25),0 0 0 1px rgba(148,163,184,.1);overflow:hidden;z-index:9990;display:none;border:1px solid var(--st-border);}',
      '.st-panel.show{display:block;animation:stSlideIn .28s cubic-bezier(.16,1,.3,1)}',
      '@keyframes stSlideIn{from{transform:translateY(20px) scale(.97);opacity:0}to{transform:none;opacity:1}}',
      '.st-head{background:linear-gradient(135deg,#6366f1 0%,#4f46e5 100%);color:#fff;padding:12px 14px 14px;position:relative;cursor:move}',
      '.st-head .grip{position:absolute;top:10px;left:10px;color:#e0e7ff;font-size:13px;letter-spacing:-3px;cursor:grab}',
      '.st-head .close{position:absolute;top:8px;right:10px;color:#e0e7ff;background:transparent;border:0;font-size:15px;cursor:pointer}',
      '.st-head h4{margin:4px 0 0;font-size:15px;font-weight:700;padding:0 24px;text-align:center;color:#fff}',
      '.st-head .sub{font-size:11px;opacity:.9;text-align:center;margin-top:2px}',
      '.st-progress{margin-top:10px;height:5px;background:rgba(255,255,255,.22);border-radius:99px;overflow:hidden}',
      '.st-progress .bar{height:100%;background:#fff;border-radius:99px;transition:width .4s ease}',
      '.st-tasks{max-height:360px;overflow-y:auto;background:var(--st-bg)}',
      '.st-task{display:flex;gap:12px;padding:12px 14px;align-items:flex-start;border-bottom:1px solid var(--st-border-light);cursor:pointer;background:#fff;transition:background .15s}',
      '.st-task:hover{background:#f8fafc}',
      '.st-task.active{background:var(--st-brand-soft);border-left:3px solid var(--st-brand);padding-left:11px}',
      '.st-task .num{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12.5px;flex-shrink:0;background:var(--st-bg-alt);color:var(--st-text-soft)}',
      '.st-task.active .num{background:var(--st-brand);color:#fff;box-shadow:0 0 0 4px rgba(99,102,241,.22)}',
      '.st-task.done .num{background:var(--st-ok);color:#fff}',
      '.st-task .body{flex:1;min-width:0}',
      '.st-task .title-row{display:flex;justify-content:space-between;align-items:center;gap:6px}',
      '.st-task .title{font-size:13px;font-weight:600}',
      '.st-task .desc{font-size:11.5px;color:var(--st-text-soft);line-height:1.4;margin-top:2px}',
      '.st-task .actions{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}',
      '.st-task .actions .stbtn{padding:4px 10px;font-size:11.5px;border-radius:7px;border:1px solid var(--st-border);background:#fff;cursor:pointer;font-weight:500}',
      '.st-task .actions .stbtn.primary{background:var(--st-brand);border-color:var(--st-brand);color:#fff;font-weight:600}',
      '.st-task .actions .stbtn.markdone{background:var(--st-ok-soft);color:#047857;border-color:#a7f3d0;font-weight:600}',
      '.st-task .actions .stbtn.markdone:hover{background:#bbf7d0}',
      '.st-task .stat{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;padding:2px 7px;border-radius:99px}',
      '.st-task .stat.pending{background:var(--st-bg-alt);color:var(--st-muted)}',
      '.st-task .stat.active{background:var(--st-warn-soft);color:#b45309}',
      '.st-task .stat.done{background:var(--st-ok-soft);color:#047857}',
      '.st-foot{background:var(--st-brand-soft);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--st-brand-dark);font-weight:500}',
      '.st-foot .chip{background:#fff;border:1px solid rgba(99,102,241,.2);color:var(--st-brand-dark);font-weight:700;padding:3px 10px;border-radius:99px;font-size:11px}',
      '.coach-overlay{position:fixed;inset:0;z-index:9998;display:none;pointer-events:none}',
      '.coach-overlay.show{display:block;animation:stFadeIn .2s ease}',
      '@keyframes stFadeIn{from{opacity:0}to{opacity:1}}',
      '.coach-cut{position:absolute;border-radius:8px;background:transparent;box-shadow:0 0 0 99999px rgba(15,23,42,.62),0 0 0 3px var(--st-brand),0 0 25px rgba(99,102,241,.7);pointer-events:none;animation:stCutGlow 1.6s ease-in-out infinite}',
      '@keyframes stCutGlow{0%,100%{box-shadow:0 0 0 99999px rgba(15,23,42,.62),0 0 0 3px var(--st-brand),0 0 25px rgba(99,102,241,.7)}50%{box-shadow:0 0 0 99999px rgba(15,23,42,.62),0 0 0 3px #a5b4fc,0 0 40px rgba(99,102,241,1)}}',
      '.coach-hint{position:absolute;pointer-events:none;background:var(--st-brand);color:#fff;padding:3px 9px;border-radius:99px;font-size:10.5px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;box-shadow:0 6px 14px rgba(99,102,241,.5);animation:stHintBob 1.5s ease-in-out infinite;z-index:9999}',
      '@keyframes stHintBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
      '.coach-pop{position:absolute;pointer-events:auto;background:#fff;border-radius:14px;padding:14px 16px;width:320px;box-shadow:0 20px 50px rgba(15,23,42,.3);border:1px solid var(--st-border)}',
      '.coach-pop .stepNo{font-size:10.5px;font-weight:700;color:var(--st-brand);text-transform:uppercase;letter-spacing:.5px}',
      '.coach-pop h5{margin:4px 0 6px;font-size:14px}',
      '.coach-pop p{margin:0 0 12px;font-size:12.5px;color:var(--st-text-soft);line-height:1.5}',
      '.coach-pop .row{display:flex;gap:6px;align-items:center}',
      '.coach-pop .stbtn{padding:5px 12px;font-size:12px;border-radius:7px;border:1px solid var(--st-border);background:#fff;cursor:pointer}',
      '.coach-pop .stbtn.primary{background:var(--st-brand);border-color:var(--st-brand);color:#fff;font-weight:600}',
      '.coach-pop .skip{font-size:11px;color:var(--st-muted);margin-left:auto;text-decoration:underline;cursor:pointer}',
      '.coach-pop .arrow{position:absolute;width:0;height:0;border:10px solid transparent}',
      '.coach-pop.arr-left .arrow{top:22px;left:-20px;border-right-color:#fff}',
      '.coach-pop.arr-right .arrow{top:22px;right:-20px;border-left-color:#fff}',
      '.coach-pop.arr-up .arrow{top:-20px;left:30px;border-bottom-color:#fff}',
      '.coach-pop.arr-down .arrow{bottom:-20px;left:30px;border-top-color:#fff}',
      '.st-welcome{position:fixed;inset:0;background:rgba(15,23,42,.6);display:none;align-items:center;justify-content:center;z-index:10000}',
      '.st-welcome.show{display:flex}',
      '.st-welcome .card2{background:#fff;border-radius:14px;padding:30px;width:480px;max-width:92vw;text-align:center;box-shadow:0 20px 50px rgba(15,23,42,.35);border:1px solid var(--st-border)}',
      '.st-welcome .hero{font-size:46px;margin-bottom:8px}',
      '.st-welcome h2{margin:4px 0 8px;font-size:22px}',
      '.st-welcome p{color:var(--st-text-soft);font-size:13.5px;margin-bottom:22px;line-height:1.6}',
      '.st-welcome .cta{display:flex;gap:8px;justify-content:center}',
      '.st-welcome .stbtn{padding:9px 16px;border-radius:9px;border:1px solid var(--st-border);background:#fff;cursor:pointer;font-size:13.5px}',
      '.st-welcome .stbtn.primary{background:var(--st-brand);border-color:var(--st-brand);color:#fff;font-weight:600}',
      '.st-done{padding:26px 18px 20px;text-align:center;background:#fff}',
      '.st-done .party{font-size:46px;margin-bottom:6px}',
      '.st-done h3{margin:4px 0 8px}',
      '.st-done p{color:var(--st-text-soft);font-size:12.5px;line-height:1.5;margin:0 0 16px}',
      '.st-done .row{display:flex;gap:6px;justify-content:center}',
      '.st-done .stbtn{padding:7px 14px;border-radius:8px;border:1px solid var(--st-border);background:#fff;cursor:pointer;font-size:12.5px}',
      '.st-done .stbtn.primary{background:var(--st-brand);border-color:var(--st-brand);color:#fff;font-weight:600}',
      /* Header chip — mockup's topbar "🚀 Setup in progress", now stage-wise */
      '.st-hchip{display:inline-flex;align-items:center;gap:6px;background:var(--st-brand-soft);border:1px solid rgba(99,102,241,.25);color:var(--st-brand-dark);font-weight:700;font-size:11.5px;padding:5px 10px;border-radius:99px;cursor:pointer;white-space:nowrap;position:relative}',
      '.st-hchip:hover{background:#e0e7ff}',
      '.st-hchip .dot{width:6px;height:6px;border-radius:50%;background:#f59e0b}',
      '.st-hchip.allok .dot{background:var(--st-ok)}',
      '.st-hmenu{position:fixed;background:#fff;border:1px solid var(--st-border);border-radius:12px;box-shadow:0 20px 50px rgba(15,23,42,.22);width:280px;z-index:9995;display:none;overflow:hidden}',
      '.st-hmenu.show{display:block}',
      '.st-hmenu .hd{padding:10px 12px;background:var(--st-brand-soft);font-size:11.5px;font-weight:700;color:var(--st-brand-dark);display:flex;justify-content:space-between;align-items:center}',
      '.st-hrow{display:flex;align-items:center;gap:9px;padding:9px 12px;border-top:1px solid var(--st-border-light);cursor:pointer;font-size:12.5px}',
      '.st-hrow:hover{background:#f8fafc}',
      '.st-hrow .ic{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;background:var(--st-bg-alt);color:var(--st-muted)}',
      '.st-hrow.done .ic{background:var(--st-ok);color:#fff}',
      '.st-hrow .nm{flex:1;min-width:0}',
      '.st-hrow .nm b{display:block;font-weight:600}',
      '.st-hrow .nm span{font-size:10.5px;color:var(--st-text-soft)}',
      '.st-hrow .tag{font-size:9.5px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:99px;background:var(--st-bg-alt);color:var(--st-muted)}',
      '.st-hrow.done .tag{background:var(--st-ok-soft);color:#047857}',
      '.st-hmenu .ft{padding:9px 12px;border-top:1px solid var(--st-border-light);text-align:center}',
      '.st-hmenu .ft button{width:100%;padding:7px;border-radius:8px;border:0;background:var(--st-brand);color:#fff;font-weight:600;font-size:12px;cursor:pointer}'
    ].join('\n');
    document.head.appendChild(css);
  }

  /* ── DOM shells ── */
  function buildDom() {
    if (document.getElementById('st-panel')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = [
      '<div class="st-welcome" id="st-welcome"><div class="card2">',
        '<div class="hero">🚀</div>',
        '<h2 id="st-welcome-title">Welcome to SmartCRM!</h2>',
        '<p>We\'ve queued <b>4 quick tasks</b> so your CRM is production-ready in ~10 minutes.<br>',
        'I\'ll take you to each page and highlight the exact field.<br>',
        '<span style="color:#6366f1;font-weight:600">Ready?</span></p>',
        '<div class="cta">',
          '<button class="stbtn primary" id="st-w-start">🎯 Start setup</button>',
          '<button class="stbtn" id="st-w-later">Maybe later</button>',
        '</div>',
      '</div></div>',
      '<div class="st-badge" id="st-badge"><div class="rocket">🚀</div><div class="count" id="st-badge-count">0/4</div></div>',
      '<div class="st-panel" id="st-panel">',
        '<div class="st-head" id="st-drag">',
          '<span class="grip">⋮⋮</span>',
          '<button class="close" id="st-close">✕</button>',
          '<h4>🚀 Setup Guide</h4>',
          '<div class="sub">Get your CRM ready in 10 minutes</div>',
          '<div class="st-progress"><div class="bar" id="st-bar" style="width:0%"></div></div>',
        '</div>',
        '<div class="st-tasks" id="st-tasksBox"></div>',
        '<div class="st-foot" id="st-foot"><span>⏱ <b id="st-days">10</b> days left</span><span class="chip" id="st-pct">0% done</span></div>',
      '</div>',
      '<div class="coach-overlay" id="st-coach">',
        '<div class="coach-cut" id="st-cut"></div>',
        '<div class="coach-hint" id="st-hint">↑ Type here</div>',
        '<div class="coach-pop" id="st-pop">',
          '<div class="stepNo" id="st-pop-step">Step 1 of 3</div>',
          '<h5 id="st-pop-title"></h5>',
          '<p id="st-pop-desc"></p>',
          '<p style="font-size:11px;color:#6366f1;font-weight:600;margin:-6px 0 10px">✨ Go ahead — type / click / upload right on the highlighted area.</p>',
          '<div class="row">',
            '<button class="stbtn primary" id="st-next">Next →</button>',
            '<button class="stbtn" id="st-video">🎬 Video</button>',
            '<span class="skip" id="st-skip">Skip task</span>',
          '</div>',
          '<div class="arrow"></div>',
        '</div>',
      '</div>'
    ].join('');
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

    document.getElementById('st-badge').onclick = openPanel;
    document.getElementById('st-close').onclick = collapse;
    document.getElementById('st-w-start').onclick = function () { hideWelcome(); openPanel(); };
    document.getElementById('st-w-later').onclick = function () { hideWelcome(); collapse(); };
    document.getElementById('st-next').onclick = coachNext;
    document.getElementById('st-skip').onclick = skipTour;
    document.getElementById('st-video').onclick = function () { watchVideo(S.curTask); };
    initDrag();
  }

  function openPanel() { document.getElementById('st-badge').style.display = 'none'; document.getElementById('st-panel').classList.add('show'); }
  function collapse()  { document.getElementById('st-panel').classList.remove('show'); document.getElementById('st-badge').style.display = 'flex'; }
  function showWelcome() { document.getElementById('st-welcome').classList.add('show'); }
  function hideWelcome() {
    document.getElementById('st-welcome').classList.remove('show');
    try { api('api_setup_seenWelcome'); } catch (e) {}
  }

  /* ── Render the task list ── */
  function renderTasks() {
    var box = document.getElementById('st-tasksBox');
    if (!box) return;
    box.innerHTML = '';
    S.tasks.forEach(function (t, i) {
      var st = t.done ? 'done' : (S.curTask === i ? 'active' : 'pending');
      var div = document.createElement('div');
      div.className = 'st-task ' + st;
      div.onclick = function () { startTask(i); };
      div.innerHTML =
        '<div class="num">' + (st === 'done' ? '✓' : (i + 1)) + '</div>' +
        '<div class="body">' +
          '<div class="title-row">' +
            '<div class="title">' + t.title + '</div>' +
            '<span class="stat ' + st + '">' + (st === 'done' ? '✓ Done' : st === 'active' ? '● Active' : 'Pending') + '</span>' +
          '</div>' +
          '<div class="desc">' + t.desc + '</div>' +
          '<div class="actions">' +
            (st === 'done'
              ? '<button class="stbtn" data-a="reopen" data-i="' + i + '" style="color:#94a3b8">↻ Reopen</button>' +
                '<button class="stbtn" data-a="redo" data-i="' + i + '">Redo tour</button>' +
                '<button class="stbtn" data-a="video" data-i="' + i + '">🎬 Video</button>'
              : '<button class="stbtn primary" data-a="start" data-i="' + i + '">' + (st === 'active' ? 'Continue' : 'Guide me →') + '</button>' +
                '<button class="stbtn markdone" data-a="done" data-i="' + i + '" title="Mark this task as complete without the guided tour">✓ Mark Done</button>' +
                '<button class="stbtn" data-a="video" data-i="' + i + '">🎬 Video</button>') +
          '</div>' +
        '</div>';
      box.appendChild(div);
    });
    box.querySelectorAll('[data-a]').forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var i = Number(b.dataset.i), a = b.dataset.a;
        if (a === 'start' || a === 'redo') startTask(i);
        else if (a === 'done')   markDone(i);
        else if (a === 'reopen') reopen(i);
        else if (a === 'video')  watchVideo(i);
      };
    });
    var pct = Math.round((S.done / Math.max(1, S.total)) * 100);
    document.getElementById('st-bar').style.width = pct + '%';
    document.getElementById('st-pct').textContent = pct + '% done';
    document.getElementById('st-badge-count').textContent = S.done + '/' + S.total;
    document.getElementById('st-days').textContent = S.daysLeft;
    renderHeaderChip();
  }

  /* ── Header chip (mockup topbar "🚀 Setup in progress") — stage-wise ── */
  function renderHeaderChip() {
    var bar = document.querySelector('.topbar-right');
    if (!bar) { setTimeout(renderHeaderChip, 800); return; }

    var chip = document.getElementById('st-hchip');
    if (!chip) {
      chip = document.createElement('span');
      chip.id = 'st-hchip';
      chip.className = 'st-hchip';
      bar.insertBefore(chip, bar.firstChild);
      chip.onclick = function (e) { e.stopPropagation(); toggleHeaderMenu(); };
    }
    var allOk = S.done === S.total;
    chip.className = 'st-hchip' + (allOk ? ' allok' : '');
    chip.innerHTML = '<span class="dot"></span>🚀 Setup ' + S.done + '/' + S.total;
    chip.title = 'Setup progress — click to see what is done and what is pending';

    var menu = document.getElementById('st-hmenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'st-hmenu';
      menu.className = 'st-hmenu';
      document.body.appendChild(menu);
      document.addEventListener('click', function () { menu.classList.remove('show'); });
    }
    var pct = Math.round((S.done / Math.max(1, S.total)) * 100);
    var rows = S.tasks.map(function (t, i) {
      return '<div class="st-hrow ' + (t.done ? 'done' : '') + '" data-i="' + i + '">' +
               '<div class="ic">' + (t.done ? '✓' : (i + 1)) + '</div>' +
               '<div class="nm"><b>' + t.title + '</b><span>' + (t.detail || '') + '</span></div>' +
               '<span class="tag">' + (t.done ? 'Done' : 'Pending') + '</span>' +
             '</div>';
    }).join('');
    menu.innerHTML =
      '<div class="hd"><span>🚀 Setup Guide</span><span>' + pct + '% done</span></div>' +
      rows +
      '<div class="ft"><button id="st-hopen">Open Setup Guide</button></div>';
    menu.querySelectorAll('.st-hrow').forEach(function (r) {
      r.onclick = function (e) {
        e.stopPropagation();
        menu.classList.remove('show');
        startTask(Number(r.dataset.i));
      };
    });
    menu.querySelector('#st-hopen').onclick = function (e) {
      e.stopPropagation(); menu.classList.remove('show'); openPanel();
    };
  }
  function toggleHeaderMenu() {
    var chip = document.getElementById('st-hchip'), menu = document.getElementById('st-hmenu');
    if (!chip || !menu) return;
    if (menu.classList.contains('show')) { menu.classList.remove('show'); return; }
    var r = chip.getBoundingClientRect();
    menu.style.top = (r.bottom + 8) + 'px';
    menu.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 292)) + 'px';
    menu.classList.add('show');
  }

  /* ── Task actions (backed by the real API) ── */
  function startTask(i) {
    var t = S.tasks[i]; if (!t) return;
    S.curTask = i; S.curStep = 0;
    renderTasks(); collapse();
    var c = COACH[t.key];
    if (!c) return;
    location.hash = c.route;
    if (c.tab) setTimeout(function () { try { window.showAdminTab && window.showAdminTab(c.tab); } catch (e) {} }, 180);
    setTimeout(showCoach, 700);   // let the real page render
  }
  function markDone(i) {
    var t = S.tasks[i]; if (!t) return;
    api('api_setup_setState', { key: t.key, done: 1 }).then(function () {
      confettiBurst(); refresh(true);
    }).catch(function (e) { window.toast && toast(e.message, 'err'); });
  }
  function reopen(i) {
    var t = S.tasks[i]; if (!t) return;
    api('api_setup_setState', { key: t.key, done: 'auto' }).then(function () { refresh(true); })
      .catch(function (e) { window.toast && toast(e.message, 'err'); });
  }
  function watchVideo(i) {
    var t = S.tasks[i == null ? 0 : i]; if (!t) return;
    var c = COACH[t.key];
    if (c && c.video) window.open(c.video, '_blank');
  }

  /* ── Coach-mark engine (spotlight + auto-advance) ── */
  var _cleanup = null;
  function showCoach() {
    var t = S.tasks[S.curTask]; if (!t) return;
    var c = COACH[t.key]; if (!c) return;
    var step = c.steps[S.curStep];
    if (!step) return coachNext();
    var el = document.querySelector(step.target);
    if (!el) {   // page not ready yet — retry briefly
      if ((showCoach._retry = (showCoach._retry || 0) + 1) < 12) return setTimeout(showCoach, 350);
      showCoach._retry = 0;
      return;
    }
    showCoach._retry = 0;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}

    setTimeout(function () {
      var r = el.getBoundingClientRect();
      var cut = document.getElementById('st-cut');
      cut.style.top = (r.top - 6) + 'px'; cut.style.left = (r.left - 6) + 'px';
      cut.style.width = (r.width + 12) + 'px'; cut.style.height = (r.height + 12) + 'px';

      var isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
      var isDrop = /logo/i.test(el.id || '');
      var hint = document.getElementById('st-hint');
      hint.textContent = isInput ? '✍ Type here' : isDrop ? '📷 Upload here' : '👆 Click me';
      hint.style.top = (r.top - 30) + 'px';
      hint.style.left = (r.left + r.width / 2 - 60) + 'px';

      var pop = document.getElementById('st-pop');
      pop.className = 'coach-pop arr-' + (step.arrow || 'left');
      document.getElementById('st-pop-step').textContent = 'Step ' + (S.curStep + 1) + ' of ' + c.steps.length;
      document.getElementById('st-pop-title').textContent = step.title;
      document.getElementById('st-pop-desc').textContent = step.desc;
      var W = 320;
      if (step.arrow === 'right')      { pop.style.top = r.top + 'px';           pop.style.left = (r.right + 24) + 'px'; }
      else if (step.arrow === 'left')  { pop.style.top = r.top + 'px';           pop.style.left = (r.left - W - 24) + 'px'; }
      else if (step.arrow === 'up')    { pop.style.top = (r.bottom + 24) + 'px'; pop.style.left = r.left + 'px'; }
      else                             { pop.style.top = (r.top - 130) + 'px';   pop.style.left = r.left + 'px'; }
      // keep the popover on-screen
      var pl = parseInt(pop.style.left, 10);
      if (pl + W > window.innerWidth - 12) pop.style.left = (window.innerWidth - W - 12) + 'px';
      if (pl < 12) pop.style.left = '12px';

      document.getElementById('st-coach').classList.add('show');

      /* auto-advance when the user actually does the thing */
      if (_cleanup) _cleanup();
      var advance = function () { setTimeout(coachNext, 700); };
      var onInput = function () { if (el.value && String(el.value).trim().length > 1) { el.removeEventListener('input', onInput); advance(); } };
      var onClick = function () { el.removeEventListener('click', onClick); advance(); };
      if (isInput) el.addEventListener('input', onInput); else el.addEventListener('click', onClick);
      _cleanup = function () { el.removeEventListener('input', onInput); el.removeEventListener('click', onClick); };
    }, 260);
  }

  function coachNext() {
    var t = S.tasks[S.curTask]; if (!t) return;
    var c = COACH[t.key];
    S.curStep++;
    if (S.curStep >= c.steps.length) {
      hideCoach();
      // Re-check the REAL state — the stage ticks itself if the work is done.
      refresh(true).then(function () {
        openPanel(); confettiBurst();
      });
    } else showCoach();
  }
  function hideCoach() {
    if (_cleanup) { _cleanup(); _cleanup = null; }
    var c = document.getElementById('st-coach');
    if (c) c.classList.remove('show');
  }
  function skipTour() {
    hideCoach();
    S.curTask = null; S.curStep = 0;
    renderTasks(); openPanel();
  }

  /* ── Completion ── */
  function showCompletion() {
    confettiBurst();
    var box = document.getElementById('st-tasksBox');
    box.innerHTML =
      '<div class="st-done">' +
        '<div class="party">🎉</div>' +
        '<h3>You\'re all set!</h3>' +
        '<p>Your CRM is production-ready. Leads will flow in and get auto-assigned.<br>Explore the sidebar, or ask Copilot: <b>"What should I do first today?"</b></p>' +
        '<div class="row">' +
          '<button class="stbtn primary" id="st-copilot">✨ Ask Copilot</button>' +
          '<button class="stbtn" id="st-finish">Close</button>' +
        '</div>' +
      '</div>';
    document.getElementById('st-foot').style.display = 'none';
    document.getElementById('st-copilot').onclick = function () {
      var f = document.querySelector('[title*="Ask CRM"], #copilot-fab');
      if (f) f.click();
    };
    document.getElementById('st-finish').onclick = function () {
      api('api_setup_dismiss', { dismissed: 1 }).catch(function () {});
      document.getElementById('st-panel').classList.remove('show');
      document.getElementById('st-badge').style.display = 'none';
    };
    openPanel();
  }

  function confettiBurst() {
    var colors = ['#6366f1', '#4f46e5', '#a5b4fc', '#818cf8', '#10b981', '#f59e0b'];
    for (var i = 0; i < 55; i++) {
      var p = document.createElement('div');
      p.style.cssText = 'position:fixed;top:50%;left:50%;width:8px;height:8px;background:' + colors[i % colors.length] + ';border-radius:' + (i % 2 ? '2px' : '50%') + ';pointer-events:none;z-index:99999;';
      document.body.appendChild(p);
      var a = Math.random() * Math.PI * 2, v = 200 + Math.random() * 220;
      p.animate([
        { transform: 'translate(0,0) rotate(0)', opacity: 1 },
        { transform: 'translate(' + Math.cos(a) * v + 'px,' + Math.sin(a) * v + 'px) rotate(720deg)', opacity: 0 }
      ], { duration: 1600, easing: 'cubic-bezier(.16,1,.3,1)' });
      (function (el) { setTimeout(function () { el.remove(); }, 1600); })(p);
    }
  }

  /* ── Drag the panel by its header ── */
  function initDrag() {
    var drag = document.getElementById('st-drag'), panel = document.getElementById('st-panel');
    var sx, sy, ox, oy, dragging = false;
    drag.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('close')) return;
      dragging = true;
      var r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      panel.style.left = (ox + e.clientX - sx) + 'px';
      panel.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', function () { dragging = false; document.body.style.userSelect = ''; });
  }

  /* ── Boot / refresh from the real backend ── */
  function refresh(keepOpen) {
    return api('api_setup_status').then(function (r) {
      if (!r || !r.admin) { teardown(); return r; }
      S.tasks = r.tasks || []; S.done = r.done_count; S.total = r.total;
      S.daysLeft = r.days_left == null ? 10 : r.days_left;

      if (r.all_done) {
        injectCss(); buildDom();
        if (r.just_completed) { renderTasks(); showCompletion(); return r; }
        teardown(); return r;
      }
      if (r.dismissed) { teardown(); return r; }

      injectCss(); buildDom(); renderTasks();
      if (!r.welcome_seen) { setTimeout(showWelcome, 350); }
      else if (!keepOpen && !document.getElementById('st-panel').classList.contains('show')) collapse();
      return r;
    }).catch(function () { return null; });
  }
  function teardown() {
    ['st-panel', 'st-badge', 'st-welcome', 'st-coach', 'st-hchip', 'st-hmenu'].forEach(function (id) {
      var e = document.getElementById(id); if (e) e.remove();
    });
  }

  function boot() {
    if (S.booted) return;
    // Wait for the SPA's api() + a token. We do NOT gate on CRM.user here —
    // it isn't reliably populated at this point. The BACKEND is the real gate:
    // api_setup_status returns admin:false for every non-admin role, and
    // refresh() tears the UI down in that case.
    var tok = null;
    try { tok = localStorage.getItem('crm_token_' + (window.TENANT_SLUG || '')) || localStorage.getItem('crm_token'); } catch (e) {}
    if (typeof window.api !== 'function' || !tok) {
      if ((boot._n = (boot._n || 0) + 1) > 40) return;   // give up after ~20s
      return setTimeout(boot, 500);
    }
    S.booted = true;
    refresh(false);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 1200);
  else window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1200); });

  window.SETUP_TOUR = { open: openPanel, refresh: refresh, start: startTask };
})();
