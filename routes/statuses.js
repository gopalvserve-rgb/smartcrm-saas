const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

// PIPELINE_STAGE_v1 (2026-05-28) — universal pipeline stage every status
// can be linked to. Lets the admin map their tenant-specific status names
// (e.g. "Not Pick", "Hot", "Demo Done") to one of 7 cross-tenant stages
// so the new funnel pipeline view + dashboard widget can aggregate
// consistently across all tenants and packs.
const PIPE_STAGES = ['fresh', 'attempted', 'qualified', 'negotiation', 'proposal', 'won', 'lost'];

// PIPELINE_STAGE_HEAL_PERTENANT_v1 (2026-06-04): the previous
// implementation cached `_healed = true` at module level, which meant
// the very first tenant to hit api_statuses_save would flip the flag
// and every OTHER tenant in the same Node process would then skip the
// ALTER. Cross-tenant pool design + module-level state == bad.
//
// Fix: always run the ALTER. It's idempotent (IF NOT EXISTS), the cost
// is negligible compared to the round-trip you're already paying for,
// and it self-heals every tenant that hits this route.
//
// Returns true if the column now exists (or already did), false if the
// ALTER threw — in which case callers must strip `stage` from payloads.
async function _heal() {
  try {
    await db.query(`ALTER TABLE statuses ADD COLUMN IF NOT EXISTS stage TEXT`);
    return true;
  } catch (e) {
    console.warn('[statuses] stage column heal failed:', e.message);
    return false;
  }
}

async function api_statuses_list(token) {
  await authUser(token);
  await _heal();
  return (await db.getAll('statuses')).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
}
async function api_statuses_save(token, s) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!s.name) throw new Error('name required');
  const haveStage = await _heal();
  const payload = {
    name: s.name,
    color: s.color || '#6b7280',
    sort_order: Number(s.sort_order) || 10,
    is_final: Number(s.is_final) || 0
  };
  // Only include `stage` if the column actually exists on this tenant.
  if (haveStage) {
    payload.stage = PIPE_STAGES.includes(String(s.stage || '').toLowerCase())
      ? String(s.stage).toLowerCase()
      : null;
  }
  if (s.id) {
    await db.update('statuses', s.id, payload);
    // PIPELINE_STAGE_SAVE_FIX_v1 — belt-and-braces: write `stage` via raw
    // SQL too in case an older db/pg.js (deployed mid-rollout) still has
    // the old column whitelist that drops `stage`.
    try {
      await db.query('UPDATE statuses SET stage = $1 WHERE id = $2', [payload.stage, Number(s.id)]);
    } catch (e) { console.warn('[statuses] raw stage update failed:', e.message); }
    return { id: Number(s.id) };
  }
  const id = await db.insert('statuses', payload);
  try {
    if (payload.stage) await db.query('UPDATE statuses SET stage = $1 WHERE id = $2', [payload.stage, Number(id)]);
  } catch (e) { console.warn('[statuses] raw stage insert update failed:', e.message); }
  return { id };
}
async function api_statuses_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  // Reassign any leads using this status to 'New' first (if exists), else null
  const leads = await db.getAll('leads');
  const news = await db.findOneBy('statuses', 'name', 'New');
  const replacement = news && Number(news.id) !== Number(id) ? news.id : null;
  for (const l of leads) {
    if (Number(l.status_id) === Number(id)) {
      await db.update('leads', l.id, { status_id: replacement });
    }
  }
  await db.removeRow('statuses', id);
  return { ok: true };
}

// PIPELINE_STAGE_v1 — aggregate every lead by its status.stage and return
// the funnel-ready payload for the new Pipeline view + Dashboard widget.
// Filters: { from, to, user_ids, source_ids }
async function api_pipeline_funnel(token, payload) {
  const me = await authUser(token);
  await _heal();
  const p = payload || {};
  const statuses = await db.getAll('statuses');
  const stageByStatusId = {};
  statuses.forEach(st => { if (st.stage) stageByStatusId[Number(st.id)] = st.stage; });

  // DASHBOARD_SCOPE_v1 — replace brittle manual role checks with
  // getVisibleUserIds(), the same helper used by every other scoped endpoint.
  // Old code only handled 4 hardcoded role strings; any custom role fell
  // through with zero scope SQL and saw ALL leads (fail-open). Also fixes
  // managers who were scoped only 1 level deep instead of the full subtree.
  let scopeSql = '';
  const args = [];
  let ai = 1;
  if (me.role !== 'admin') {
    const visible = await getVisibleUserIds(me);
    scopeSql += ` AND assigned_to = ANY($${ai++}::int[])`;
    args.push(visible.map(Number));
  }
  if (p.from) { scopeSql += ` AND created_at >= $${ai++}::timestamptz`; args.push(p.from); }
  if (p.to)   { scopeSql += ` AND created_at <= $${ai++}::timestamptz`; args.push(p.to); }
  if (Array.isArray(p.user_ids) && p.user_ids.length) {
    scopeSql += ` AND assigned_to = ANY($${ai++}::int[])`;
    args.push(p.user_ids.map(x => Number(x)).filter(Boolean));
  }
  if (Array.isArray(p.source_ids) && p.source_ids.length) {
    scopeSql += ` AND source = ANY($${ai++}::text[])`;
    args.push(p.source_ids.map(String));
  }
  // PIPELINE_FUNNEL_FILTERS_v1 — product / campaign / status filters
  if (Array.isArray(p.product_ids) && p.product_ids.length) {
    scopeSql += ` AND product_id = ANY($${ai++}::int[])`;
    args.push(p.product_ids.map(x => Number(x)).filter(Boolean));
  }
  if (Array.isArray(p.campaign_ids) && p.campaign_ids.length) {
    scopeSql += ` AND campaign_id = ANY($${ai++}::int[])`;
    args.push(p.campaign_ids.map(x => Number(x)).filter(Boolean));
  }
  if (Array.isArray(p.status_ids) && p.status_ids.length) {
    scopeSql += ` AND status_id = ANY($${ai++}::int[])`;
    args.push(p.status_ids.map(x => Number(x)).filter(Boolean));
  }

  const r = await db.query(
    `SELECT id, status_id, value, last_status_change_at, created_at
       FROM leads
      WHERE 1=1 ${scopeSql}`,
    args
  );
  const leads = r.rows || [];

  // Stages in display order
  const STAGE_ORDER = ['fresh', 'attempted', 'qualified', 'negotiation', 'proposal'];
  const STAGE_LABELS = {
    fresh: 'New lead', attempted: 'Contacted', qualified: 'Qualified',
    negotiation: 'Negotiation', proposal: 'Proposal sent',
    won: 'Won', lost: 'Lost'
  };
  const buckets = {};
  STAGE_ORDER.concat(['won', 'lost']).forEach(k => { buckets[k] = { count: 0, value: 0 }; });
  // unmapped statuses pool — counted but not shown in the funnel
  let unmapped = { count: 0, value: 0 };
  let totalOpen = 0;
  let openValue = 0;
  let cycleSumDays = 0;
  let cycleSamples = 0;

  for (const l of leads) {
    const stg = stageByStatusId[Number(l.status_id)] || null;
    const v   = Number(l.value) || 0;
    if (!stg) { unmapped.count++; unmapped.value += v; continue; }
    const b = buckets[stg];
    if (!b) { unmapped.count++; unmapped.value += v; continue; }
    b.count++;
    b.value += v;
    if (stg !== 'won' && stg !== 'lost') {
      totalOpen++;
      openValue += v;
    }
    // Avg cycle: from created_at to last_status_change_at on won leads
    // (leads table has no won_at column; status changing TO won lands in
    // last_status_change_at, so this is the closest proxy).
    if (stg === 'won' && l.last_status_change_at && l.created_at) {
      const days = (new Date(l.last_status_change_at).getTime() - new Date(l.created_at).getTime()) / 86400000;
      if (days >= 0 && days < 365) { cycleSumDays += days; cycleSamples++; }
    }
  }

  const wonCount = buckets.won.count;
  const lostCount = buckets.lost.count;
  const closedTotal = wonCount + lostCount;
  const winRate = closedTotal ? Math.round((wonCount / closedTotal) * 100) : 0;
  const avgCycle = cycleSamples ? Math.round(cycleSumDays / cycleSamples) : null;

  // Each band gets pct_of_total (vs first non-empty band) + advance_pct (this/next).
  // pct_of_total is computed against the FIRST (fresh) band so the band heights
  // descend like a funnel. If fresh is empty, fall back to total open.
  const baseCount = buckets.fresh.count || totalOpen || 1;
  const bands = STAGE_ORDER.map((id, i) => {
    const b = buckets[id];
    const next = buckets[STAGE_ORDER[i + 1]];
    const pctOfTotal = Math.round((b.count / baseCount) * 100);
    let advancePct = null;
    if (next && b.count) advancePct = Math.round((next.count / b.count) * 100);
    return {
      id, label: STAGE_LABELS[id], count: b.count, value: b.value,
      pct_of_total: pctOfTotal,
      advance_pct: advancePct
    };
  });

  // Weighted value: pick a forecast weight per stage.
  const STAGE_WEIGHT = { fresh: 0.05, attempted: 0.15, qualified: 0.35, negotiation: 0.55, proposal: 0.75 };
  let weightedValue = 0;
  bands.forEach(b => { weightedValue += b.value * (STAGE_WEIGHT[b.id] || 0); });

  return {
    kpis: {
      total_leads: totalOpen,
      open_value:  Math.round(openValue),
      weighted_value: Math.round(weightedValue),
      win_rate: winRate,
      avg_cycle_days: avgCycle
    },
    bands,
    won: { count: wonCount, value: buckets.won.value },
    lost: { count: lostCount, value: buckets.lost.value },
    unmapped
  };
}

// PIPELINE_STAGE_v1 — expose the enum so the SPA can render the
// dropdown without hard-coding it on the client.
async function api_pipeline_stages(token) {
  await authUser(token);
  return [
    { id: 'fresh',       label: 'Fresh Lead',                hint: 'Just captured. Untouched.' },
    { id: 'attempted',   label: 'Attempted / Contacted',     hint: 'Reached out but no meaningful conversation yet.' },
    { id: 'qualified',   label: 'Connected & Qualified',     hint: 'Spoke with them, confirmed real fit.' },
    { id: 'negotiation', label: 'Negotiation',               hint: 'Discussing price, course details, objections.' },
    { id: 'proposal',    label: 'Proposal / Payment Link Sent', hint: 'Formal offer or payment link shared.' },
    { id: 'won',         label: 'Won',                       hint: 'Enrolled / paid.' },
    { id: 'lost',        label: 'Lost',                      hint: 'Closed lost.' }
  ];
}

module.exports = { api_statuses_list, api_statuses_save, api_statuses_delete, api_pipeline_stages, api_pipeline_funnel };
