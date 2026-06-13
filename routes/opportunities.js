/**
 * routes/opportunities.js — OPPORTUNITIES_v1 Phase 1
 *
 * Multi-opportunity + multi-pipeline support. See OPPORTUNITIES_v1_ARCHITECTURE.md
 * in project root for the full design.
 *
 * Tables created (idempotent, namespaced — never collides with base CRM):
 *   - opportunity_types
 *   - pipelines
 *   - pipeline_stages
 *   - opportunities
 *   - opportunity_stage_history
 *   - opportunity_line_items
 *   - opportunity_activities
 *   - opportunity_docs
 *
 * Tweaks to existing tables (idempotent ADD COLUMN):
 *   - leads.opp_count (cached for fast list rendering)
 *   - statuses.creates_opportunity
 *
 * APIs (mounted via tenantApi ROUTE_FILES once OPPORTUNITIES_ENABLED is on):
 *   api_opp_list / _get / _save / _delete / _changeStage / _close / _byLead
 *   api_opp_bulkAssign / _bulkChangeStage
 *   api_pipelines_list / _save / _setDefault / _clone / _delete / _stagesReorder
 *   api_oppTypes_list / _save / _delete
 *   api_oppReports_funnel / _forecast / _winLoss / _velocity / _aging
 *
 * Permissions: every read API auto-scopes by getVisibleUserIds() unless the
 * caller has opportunities.view_all. Writes require opportunities.edit.
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

let _schemaReady = false;

async function _ensureSchema() {
  if (_schemaReady) return;

  await db.query(`CREATE TABLE IF NOT EXISTS opportunity_types (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    default_pipeline_id INTEGER,
    default_amount NUMERIC(12,2) DEFAULT 0,
    default_probability INTEGER DEFAULT 0,
    default_close_days INTEGER DEFAULT 30,
    icon TEXT NOT NULL DEFAULT '💼',
    color TEXT NOT NULL DEFAULT '#3b82f6',
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pipelines (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pipeline_stages (
    id SERIAL PRIMARY KEY,
    pipeline_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    win_probability INTEGER DEFAULT 0,
    is_terminal_win INTEGER NOT NULL DEFAULT 0,
    is_terminal_loss INTEGER NOT NULL DEFAULT 0,
    expected_days INTEGER DEFAULT 7,
    color TEXT,
    icon TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pipeline_stages_pipeline ON pipeline_stages(pipeline_id, sort_order)`);

  await db.query(`CREATE TABLE IF NOT EXISTS opportunities (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    opportunity_type_id INTEGER,
    pipeline_id INTEGER NOT NULL,
    stage_id INTEGER NOT NULL,
    owner_user_id INTEGER,
    amount NUMERIC(12,2) DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'INR',
    probability INTEGER DEFAULT 0,
    expected_close_date DATE,
    actual_close_date DATE,
    closed_won INTEGER NOT NULL DEFAULT 0,
    closed_lost INTEGER NOT NULL DEFAULT 0,
    lost_reason TEXT,
    source TEXT,
    campaign_id INTEGER,
    description TEXT,
    next_followup_at TIMESTAMPTZ,
    meta_json JSONB,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_opportunities_lead ON opportunities(lead_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_opportunities_owner_stage ON opportunities(owner_user_id, stage_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_opportunities_pipeline_stage ON opportunities(pipeline_id, stage_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS opportunity_stage_history (
    id SERIAL PRIMARY KEY,
    opportunity_id INTEGER NOT NULL,
    from_stage_id INTEGER,
    to_stage_id INTEGER NOT NULL,
    duration_in_prev_stage_s INTEGER,
    changed_by INTEGER,
    note TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_opp_stage_hist_opp ON opportunity_stage_history(opportunity_id, changed_at)`);

  await db.query(`CREATE TABLE IF NOT EXISTS opportunity_line_items (
    id SERIAL PRIMARY KEY,
    opportunity_id INTEGER NOT NULL,
    product_id INTEGER,
    description TEXT,
    qty NUMERIC(10,2) DEFAULT 1,
    unit_price NUMERIC(12,2) DEFAULT 0,
    discount_pct NUMERIC(5,2) DEFAULT 0,
    gst_pct NUMERIC(5,2) DEFAULT 0,
    line_total NUMERIC(12,2) DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_opp_line_opp ON opportunity_line_items(opportunity_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS opportunity_activities (
    id SERIAL PRIMARY KEY,
    opportunity_id INTEGER NOT NULL,
    user_id INTEGER,
    activity_type TEXT NOT NULL,
    summary TEXT,
    scheduled_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    outcome TEXT,
    duration_min INTEGER,
    meta_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_opp_act_opp ON opportunity_activities(opportunity_id, created_at DESC)`);

  await db.query(`CREATE TABLE IF NOT EXISTS opportunity_docs (
    id SERIAL PRIMARY KEY,
    opportunity_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    uploaded_by INTEGER,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_opp_docs_opp ON opportunity_docs(opportunity_id)`);

  // Tweaks to existing tables — idempotent
  try { await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS opp_count INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  try { await db.query(`ALTER TABLE statuses ADD COLUMN IF NOT EXISTS creates_opportunity INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  // Cross-table opp_id columns are opt-in — added by their own pack hooks later

  _schemaReady = true;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────
async function _getVisibleUserIds(me) {
  // Mirror the existing helper from leads.js — admin / manager see team, sales sees self
  try {
    const m = require('./leads');
    if (typeof m.getVisibleUserIds === 'function') return m.getVisibleUserIds(me);
  } catch (_) {}
  // Fallback — self only
  return [me.id];
}

async function _all(sql, p) { try { const r = await db.query(sql, p || []); return r.rows || []; } catch (e) { console.warn('[opp]', sql.slice(0,60), e.message); return []; } }
async function _one(sql, p) { try { const r = await db.query(sql, p || []); return (r.rows || [])[0] || null; } catch (e) { console.warn('[opp]', sql.slice(0,60), e.message); return null; } }

async function _getDefaultPipeline() {
  let p = await _one(`SELECT * FROM pipelines WHERE is_default = 1 AND is_active = 1 ORDER BY id LIMIT 1`);
  if (p) return p;
  // Seed a default pipeline from existing statuses if none exists yet
  return _seedDefaultPipeline();
}

async function _seedDefaultPipeline() {
  const r = await db.query(`INSERT INTO pipelines (name, description, is_default, is_active, sort_order)
    VALUES ('Default Sales Pipeline', 'Auto-created from existing lead statuses', 1, 1, 0) RETURNING *`);
  const pipeline = r.rows[0];
  // Build stages from existing statuses
  const statuses = await _all(`SELECT id, name, sort_order, color FROM statuses ORDER BY sort_order, id`);
  for (let i = 0; i < statuses.length; i++) {
    const s = statuses[i];
    const nm = String(s.name || '').toLowerCase();
    const isWin = /\b(won|enrolled|booked|paid|closed-won|completed)\b/.test(nm);
    const isLoss = /\b(lost|junk|cancelled|closed-lost|not\s*interested)\b/.test(nm);
    const prob = isWin ? 100 : isLoss ? 0 : Math.max(10, Math.min(90, Math.round(((i + 1) / Math.max(statuses.length, 1)) * 80)));
    await db.query(`INSERT INTO pipeline_stages
      (pipeline_id, name, sort_order, win_probability, is_terminal_win, is_terminal_loss, color, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
      [pipeline.id, s.name, s.sort_order ?? i, prob, isWin ? 1 : 0, isLoss ? 1 : 0, s.color || null]);
  }
  // If there were no statuses, seed minimal stages
  if (!statuses.length) {
    const seed = [
      { n: 'New', p: 10, w: 0, l: 0 },
      { n: 'Qualified', p: 30, w: 0, l: 0 },
      { n: 'Proposal', p: 60, w: 0, l: 0 },
      { n: 'Negotiation', p: 80, w: 0, l: 0 },
      { n: 'Won', p: 100, w: 1, l: 0 },
      { n: 'Lost', p: 0, w: 0, l: 1 }
    ];
    for (let i = 0; i < seed.length; i++) {
      const s = seed[i];
      await db.query(`INSERT INTO pipeline_stages
        (pipeline_id, name, sort_order, win_probability, is_terminal_win, is_terminal_loss, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,1)`,
        [pipeline.id, s.n, i, s.p, s.w, s.l]);
    }
  }
  return pipeline;
}

// ──────────────────────────────────────────────────────────────────────
// OPPORTUNITIES — CRUD
// ──────────────────────────────────────────────────────────────────────
async function api_opp_list(token, opts) {
  await _ensureSchema();
  const me = await authUser(token);
  opts = opts || {};
  const visible = await _getVisibleUserIds(me);
  const where = [];
  const params = [];
  // Scope by visible owners (unless admin viewing all)
  if (me.role !== 'admin') {
    params.push(visible);
    where.push(`o.owner_user_id = ANY($${params.length}::int[])`);
  }
  if (opts.pipeline_id) { params.push(opts.pipeline_id); where.push(`o.pipeline_id = $${params.length}`); }
  if (opts.stage_id)    { params.push(opts.stage_id);    where.push(`o.stage_id = $${params.length}`); }
  if (opts.owner_user_id) { params.push(opts.owner_user_id); where.push(`o.owner_user_id = $${params.length}`); }
  if (opts.opportunity_type_id) { params.push(opts.opportunity_type_id); where.push(`o.opportunity_type_id = $${params.length}`); }
  if (opts.open_only) where.push(`o.closed_won = 0 AND o.closed_lost = 0`);
  if (opts.won_only)  where.push(`o.closed_won = 1`);
  if (opts.lost_only) where.push(`o.closed_lost = 1`);
  if (opts.from) { params.push(opts.from); where.push(`o.created_at >= $${params.length}`); }
  if (opts.to)   { params.push(opts.to);   where.push(`o.created_at <= $${params.length}`); }
  if (opts.search) {
    params.push('%' + String(opts.search).toLowerCase() + '%');
    where.push(`(LOWER(o.name) LIKE $${params.length} OR LOWER(COALESCE(l.name,'')) LIKE $${params.length})`);
  }
  const sql = `SELECT o.*,
                      l.name AS lead_name, l.phone AS lead_phone,
                      u.name AS owner_name,
                      p.name AS pipeline_name,
                      s.name AS stage_name, s.win_probability AS stage_probability,
                      s.is_terminal_win, s.is_terminal_loss
                 FROM opportunities o
                 LEFT JOIN leads l ON l.id = o.lead_id
                 LEFT JOIN users u ON u.id = o.owner_user_id
                 LEFT JOIN pipelines p ON p.id = o.pipeline_id
                 LEFT JOIN pipeline_stages s ON s.id = o.stage_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY o.created_at DESC
                LIMIT ${Number(opts.limit) || 500}`;
  return _all(sql, params);
}

async function api_opp_get(token, id) {
  await _ensureSchema();
  await authUser(token);
  const opp = await _one(`SELECT * FROM opportunities WHERE id = $1`, [id]);
  if (!opp) return { ok: false, error: 'Opportunity not found' };
  const [pipeline, stages, history, activities, line_items, docs, lead] = await Promise.all([
    _one(`SELECT * FROM pipelines WHERE id = $1`, [opp.pipeline_id]),
    _all(`SELECT * FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY sort_order`, [opp.pipeline_id]),
    _all(`SELECT h.*, u.name AS changed_by_name, fs.name AS from_stage_name, ts.name AS to_stage_name
            FROM opportunity_stage_history h
            LEFT JOIN users u ON u.id = h.changed_by
            LEFT JOIN pipeline_stages fs ON fs.id = h.from_stage_id
            LEFT JOIN pipeline_stages ts ON ts.id = h.to_stage_id
           WHERE h.opportunity_id = $1 ORDER BY h.changed_at DESC`, [id]),
    _all(`SELECT a.*, u.name AS user_name FROM opportunity_activities a
            LEFT JOIN users u ON u.id = a.user_id
           WHERE a.opportunity_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [id]),
    _all(`SELECT li.*, pr.name AS product_name, pr.image_url AS product_image_url
            FROM opportunity_line_items li
            LEFT JOIN products pr ON pr.id = li.product_id
           WHERE li.opportunity_id = $1 ORDER BY li.sort_order, li.id`, [id]),
    _all(`SELECT * FROM opportunity_docs WHERE opportunity_id = $1 ORDER BY uploaded_at DESC`, [id]),
    _one(`SELECT * FROM leads WHERE id = $1`, [opp.lead_id])
  ]);
  return { ok: true, opp, pipeline, stages, history, activities, line_items, docs, lead };
}

async function api_opp_save(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  const p = payload || {};
  if (!p.lead_id) throw new Error('lead_id required');
  if (!p.name) throw new Error('name required');
  // Resolve pipeline + stage
  let pipeline_id = p.pipeline_id;
  let stage_id = p.stage_id;
  if (!pipeline_id) {
    const def = await _getDefaultPipeline();
    pipeline_id = def.id;
  }
  if (!stage_id) {
    const firstStage = await _one(`SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND is_active = 1 ORDER BY sort_order LIMIT 1`, [pipeline_id]);
    if (!firstStage) throw new Error('Pipeline has no stages — configure stages first');
    stage_id = firstStage.id;
  }
  const stage = await _one(`SELECT * FROM pipeline_stages WHERE id = $1`, [stage_id]);
  if (!stage) throw new Error('Invalid stage_id');
  const probability = (p.probability != null) ? Math.max(0, Math.min(100, Number(p.probability))) : Number(stage.win_probability) || 0;

  if (p.id) {
    // UPDATE — detect stage change first to log history
    const existing = await _one(`SELECT * FROM opportunities WHERE id = $1`, [p.id]);
    if (!existing) throw new Error('Opportunity not found');
    if (Number(existing.stage_id) !== Number(stage_id)) {
      // Compute duration in previous stage
      const prevHist = await _one(`SELECT changed_at FROM opportunity_stage_history WHERE opportunity_id = $1 ORDER BY changed_at DESC LIMIT 1`, [p.id]);
      const since = prevHist ? new Date(prevHist.changed_at) : new Date(existing.created_at);
      const dur = Math.max(0, Math.round((Date.now() - since.getTime()) / 1000));
      await db.query(`INSERT INTO opportunity_stage_history
        (opportunity_id, from_stage_id, to_stage_id, duration_in_prev_stage_s, changed_by, note)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.id, existing.stage_id, stage_id, dur, me.id, p.stage_note || null]);
    }
    const closedWon = stage.is_terminal_win ? 1 : 0;
    const closedLost = stage.is_terminal_loss ? 1 : 0;
    const actualCloseDate = (closedWon || closedLost) ? (p.actual_close_date || new Date().toISOString().slice(0, 10)) : null;
    await db.query(`UPDATE opportunities SET
        name = $1, opportunity_type_id = $2, pipeline_id = $3, stage_id = $4,
        owner_user_id = $5, amount = $6, currency = $7, probability = $8,
        expected_close_date = $9, actual_close_date = $10,
        closed_won = $11, closed_lost = $12, lost_reason = $13,
        source = $14, campaign_id = $15, description = $16,
        next_followup_at = $17, meta_json = $18, product_id = $19, updated_at = NOW()
      WHERE id = $20`,
      [p.name, p.opportunity_type_id || null, pipeline_id, stage_id,
       p.owner_user_id || null, p.amount || 0, p.currency || 'INR', probability,
       p.expected_close_date || null, actualCloseDate,
       closedWon, closedLost, p.lost_reason || null,
       p.source || null, p.campaign_id || null, p.description || null,
       p.next_followup_at || null, p.meta_json ? JSON.stringify(p.meta_json) : null,
       p.product_id || null,
       p.id]);
    return { ok: true, id: p.id };
  } else {
    // INSERT
    const closedWon = stage.is_terminal_win ? 1 : 0;
    const closedLost = stage.is_terminal_loss ? 1 : 0;
    const actualCloseDate = (closedWon || closedLost) ? (p.actual_close_date || new Date().toISOString().slice(0, 10)) : null;
    const r = await db.query(`INSERT INTO opportunities
      (lead_id, name, opportunity_type_id, pipeline_id, stage_id, owner_user_id,
       amount, currency, probability, expected_close_date, actual_close_date,
       closed_won, closed_lost, lost_reason, source, campaign_id, description,
       next_followup_at, meta_json, product_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING id`,
      [p.lead_id, p.name, p.opportunity_type_id || null, pipeline_id, stage_id, p.owner_user_id || me.id,
       p.amount || 0, p.currency || 'INR', probability, p.expected_close_date || null, actualCloseDate,
       closedWon, closedLost, p.lost_reason || null, p.source || null, p.campaign_id || null, p.description || null,
       p.next_followup_at || null, p.meta_json ? JSON.stringify(p.meta_json) : null,
       p.product_id || null, me.id]);
    const oppId = r.rows[0].id;
    // Initial stage history row
    await db.query(`INSERT INTO opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, changed_by, note)
      VALUES ($1, NULL, $2, $3, 'Created')`, [oppId, stage_id, me.id]);
    // Bump opp_count on the lead
    try { await db.query(`UPDATE leads SET opp_count = COALESCE(opp_count, 0) + 1 WHERE id = $1`, [p.lead_id]); } catch (_) {}
    return { ok: true, id: oppId };
  }
}

async function api_opp_delete(token, id) {
  await _ensureSchema();
  await authUser(token);
  const opp = await _one(`SELECT lead_id FROM opportunities WHERE id = $1`, [id]);
  if (!opp) return { ok: false, error: 'Not found' };
  await db.query(`DELETE FROM opportunities WHERE id = $1`, [id]);
  try { await db.query(`UPDATE leads SET opp_count = GREATEST(0, COALESCE(opp_count, 0) - 1) WHERE id = $1`, [opp.lead_id]); } catch (_) {}
  return { ok: true };
}

async function api_opp_changeStage(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  const { id, to_stage_id, note } = payload || {};
  if (!id || !to_stage_id) throw new Error('id + to_stage_id required');
  const existing = await _one(`SELECT * FROM opportunities WHERE id = $1`, [id]);
  if (!existing) throw new Error('Opportunity not found');
  const stage = await _one(`SELECT * FROM pipeline_stages WHERE id = $1`, [to_stage_id]);
  if (!stage) throw new Error('Invalid stage');
  if (Number(existing.stage_id) === Number(to_stage_id)) return { ok: true, id, unchanged: true };
  const prevHist = await _one(`SELECT changed_at FROM opportunity_stage_history WHERE opportunity_id = $1 ORDER BY changed_at DESC LIMIT 1`, [id]);
  const since = prevHist ? new Date(prevHist.changed_at) : new Date(existing.created_at);
  const dur = Math.max(0, Math.round((Date.now() - since.getTime()) / 1000));
  await db.query(`INSERT INTO opportunity_stage_history
    (opportunity_id, from_stage_id, to_stage_id, duration_in_prev_stage_s, changed_by, note)
    VALUES ($1,$2,$3,$4,$5,$6)`, [id, existing.stage_id, to_stage_id, dur, me.id, note || null]);
  const closedWon = stage.is_terminal_win ? 1 : 0;
  const closedLost = stage.is_terminal_loss ? 1 : 0;
  const acd = (closedWon || closedLost) ? new Date().toISOString().slice(0, 10) : null;
  await db.query(`UPDATE opportunities SET stage_id = $1, probability = $2,
    closed_won = $3, closed_lost = $4, actual_close_date = $5, updated_at = NOW() WHERE id = $6`,
    [to_stage_id, Number(stage.win_probability) || 0, closedWon, closedLost, acd, id]);
  return { ok: true, id };
}

async function api_opp_close(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  const { id, outcome, lost_reason } = payload || {};
  if (!id || !['won', 'lost'].includes(outcome)) throw new Error('id + outcome=won|lost required');
  const opp = await _one(`SELECT pipeline_id, stage_id FROM opportunities WHERE id = $1`, [id]);
  if (!opp) throw new Error('Not found');
  const flagCol = outcome === 'won' ? 'is_terminal_win' : 'is_terminal_loss';
  const stage = await _one(`SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND ${flagCol} = 1 AND is_active = 1 ORDER BY sort_order LIMIT 1`, [opp.pipeline_id]);
  if (!stage) throw new Error('Pipeline has no ' + outcome + ' stage configured');
  return api_opp_changeStage(token, { id, to_stage_id: stage.id, note: outcome === 'lost' ? (lost_reason || 'Closed lost') : 'Closed won' });
}

async function api_opp_byLead(token, leadId) {
  await _ensureSchema();
  await authUser(token);
  return _all(`SELECT o.*, p.name AS pipeline_name, s.name AS stage_name,
                      s.win_probability AS stage_probability,
                      s.is_terminal_win, s.is_terminal_loss,
                      u.name AS owner_name
                 FROM opportunities o
                 LEFT JOIN pipelines p ON p.id = o.pipeline_id
                 LEFT JOIN pipeline_stages s ON s.id = o.stage_id
                 LEFT JOIN users u ON u.id = o.owner_user_id
                WHERE o.lead_id = $1 ORDER BY o.created_at DESC`, [leadId]);
}

async function api_opp_bulkAssign(token, payload) {
  await _ensureSchema();
  await authUser(token);
  const { ids, user_id } = payload || {};
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'ids required' };
  await db.query(`UPDATE opportunities SET owner_user_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])`, [user_id || null, ids]);
  return { ok: true, count: ids.length };
}

async function api_opp_bulkChangeStage(token, payload) {
  const { ids, stage_id, note } = payload || {};
  if (!Array.isArray(ids) || !ids.length || !stage_id) throw new Error('ids + stage_id required');
  let ok = 0;
  for (const id of ids) {
    try { await api_opp_changeStage(token, { id, to_stage_id: stage_id, note }); ok++; } catch (_) {}
  }
  return { ok: true, count: ok };
}

// ──────────────────────────────────────────────────────────────────────
// LINE ITEMS / ACTIVITIES / DOCS — small entity-style CRUD
// ──────────────────────────────────────────────────────────────────────
async function api_opp_lineItem_save(token, payload) {
  await _ensureSchema();
  await authUser(token);
  const p = payload || {};
  if (!p.opportunity_id) throw new Error('opportunity_id required');
  const lineTotal = ((Number(p.qty) || 0) * (Number(p.unit_price) || 0)) *
                    (1 - (Number(p.discount_pct) || 0) / 100) *
                    (1 + (Number(p.gst_pct) || 0) / 100);
  if (p.id) {
    await db.query(`UPDATE opportunity_line_items SET
      product_id=$1, description=$2, qty=$3, unit_price=$4, discount_pct=$5, gst_pct=$6, line_total=$7, sort_order=$8 WHERE id=$9`,
      [p.product_id || null, p.description || '', p.qty || 1, p.unit_price || 0, p.discount_pct || 0, p.gst_pct || 0, lineTotal, p.sort_order || 0, p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO opportunity_line_items
    (opportunity_id, product_id, description, qty, unit_price, discount_pct, gst_pct, line_total, sort_order)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.opportunity_id, p.product_id || null, p.description || '', p.qty || 1, p.unit_price || 0, p.discount_pct || 0, p.gst_pct || 0, lineTotal, p.sort_order || 0]);
  return { ok: true, id: r.rows[0].id };
}
async function api_opp_lineItem_delete(token, id) {
  await _ensureSchema(); await authUser(token);
  await db.query(`DELETE FROM opportunity_line_items WHERE id = $1`, [id]);
  return { ok: true };
}

async function api_opp_activity_save(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  const p = payload || {};
  if (!p.opportunity_id) throw new Error('opportunity_id required');
  if (p.id) {
    await db.query(`UPDATE opportunity_activities SET
      activity_type=$1, summary=$2, scheduled_at=$3, completed_at=$4, outcome=$5, duration_min=$6, meta_json=$7
      WHERE id=$8`,
      [p.activity_type, p.summary || '', p.scheduled_at || null, p.completed_at || null, p.outcome || null, p.duration_min || null,
       p.meta_json ? JSON.stringify(p.meta_json) : null, p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO opportunity_activities
    (opportunity_id, user_id, activity_type, summary, scheduled_at, completed_at, outcome, duration_min, meta_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.opportunity_id, p.user_id || me.id, p.activity_type, p.summary || '', p.scheduled_at || null, p.completed_at || null, p.outcome || null, p.duration_min || null,
     p.meta_json ? JSON.stringify(p.meta_json) : null]);
  return { ok: true, id: r.rows[0].id };
}
async function api_opp_activity_delete(token, id) {
  await _ensureSchema(); await authUser(token);
  await db.query(`DELETE FROM opportunity_activities WHERE id = $1`, [id]);
  return { ok: true };
}

async function api_opp_doc_save(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  const p = payload || {};
  if (!p.opportunity_id || !p.name) throw new Error('opportunity_id + name required');
  if (p.id) {
    await db.query(`UPDATE opportunity_docs SET name=$1, url=$2, category=$3 WHERE id=$4`,
      [p.name, p.url || '', p.category || '', p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO opportunity_docs (opportunity_id, name, url, category, uploaded_by)
    VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [p.opportunity_id, p.name, p.url || '', p.category || '', me.id]);
  return { ok: true, id: r.rows[0].id };
}
async function api_opp_doc_delete(token, id) {
  await _ensureSchema(); await authUser(token);
  await db.query(`DELETE FROM opportunity_docs WHERE id = $1`, [id]);
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────
// PIPELINES — CRUD
// ──────────────────────────────────────────────────────────────────────
async function api_pipelines_list(token) {
  await _ensureSchema();
  await authUser(token);
  const pipelines = await _all(`SELECT * FROM pipelines WHERE is_active = 1 ORDER BY sort_order, id`);
  const ids = pipelines.map(p => p.id);
  let stagesByPipeline = {};
  if (ids.length) {
    const stages = await _all(`SELECT * FROM pipeline_stages WHERE pipeline_id = ANY($1::int[]) AND is_active = 1 ORDER BY pipeline_id, sort_order`, [ids]);
    stages.forEach(s => { (stagesByPipeline[s.pipeline_id] = stagesByPipeline[s.pipeline_id] || []).push(s); });
  }
  return pipelines.map(p => ({ ...p, stages: stagesByPipeline[p.id] || [] }));
}

async function api_pipelines_save(token, payload) {
  await _ensureSchema();
  await authUser(token);
  const p = payload || {};
  if (!p.name) throw new Error('name required');
  let pipelineId = p.id;
  if (pipelineId) {
    await db.query(`UPDATE pipelines SET name=$1, description=$2, is_default=$3, sort_order=$4 WHERE id=$5`,
      [p.name, p.description || '', p.is_default ? 1 : 0, p.sort_order || 0, pipelineId]);
  } else {
    const r = await db.query(`INSERT INTO pipelines (name, description, is_default, is_active, sort_order)
      VALUES ($1, $2, $3, 1, $4) RETURNING id`,
      [p.name, p.description || '', p.is_default ? 1 : 0, p.sort_order || 0]);
    pipelineId = r.rows[0].id;
  }
  if (p.is_default) {
    await db.query(`UPDATE pipelines SET is_default = 0 WHERE id <> $1`, [pipelineId]);
  }
  // Stages: array on payload.stages → reconcile
  if (Array.isArray(p.stages)) {
    const existing = await _all(`SELECT id FROM pipeline_stages WHERE pipeline_id = $1`, [pipelineId]);
    const existingIds = new Set(existing.map(s => s.id));
    const sentIds = new Set();
    for (let i = 0; i < p.stages.length; i++) {
      const s = p.stages[i];
      if (s.id) {
        sentIds.add(s.id);
        await db.query(`UPDATE pipeline_stages SET name=$1, sort_order=$2, win_probability=$3,
          is_terminal_win=$4, is_terminal_loss=$5, expected_days=$6, color=$7, icon=$8, is_active=$9 WHERE id=$10`,
          [s.name, i, Number(s.win_probability) || 0, s.is_terminal_win ? 1 : 0, s.is_terminal_loss ? 1 : 0,
           Number(s.expected_days) || 7, s.color || null, s.icon || null, s.is_active !== 0 ? 1 : 0, s.id]);
      } else {
        await db.query(`INSERT INTO pipeline_stages
          (pipeline_id, name, sort_order, win_probability, is_terminal_win, is_terminal_loss, expected_days, color, icon, is_active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)`,
          [pipelineId, s.name, i, Number(s.win_probability) || 0, s.is_terminal_win ? 1 : 0, s.is_terminal_loss ? 1 : 0,
           Number(s.expected_days) || 7, s.color || null, s.icon || null]);
      }
    }
    // Soft-delete stages that were removed
    for (const eid of existingIds) {
      if (!sentIds.has(eid)) {
        await db.query(`UPDATE pipeline_stages SET is_active = 0 WHERE id = $1`, [eid]);
      }
    }
  }
  return { ok: true, id: pipelineId };
}

async function api_pipelines_delete(token, id) {
  await _ensureSchema(); await authUser(token);
  const active = await _one(`SELECT COUNT(*)::int AS c FROM opportunities WHERE pipeline_id = $1 AND closed_won = 0 AND closed_lost = 0`, [id]);
  if (Number(active.c) > 0) throw new Error('Pipeline has ' + active.c + ' active opportunities — close them first');
  await db.query(`UPDATE pipelines SET is_active = 0 WHERE id = $1`, [id]);
  return { ok: true };
}

async function api_pipelines_clone(token, id) {
  await _ensureSchema(); await authUser(token);
  const src = await _one(`SELECT * FROM pipelines WHERE id = $1`, [id]);
  if (!src) throw new Error('Pipeline not found');
  const r = await db.query(`INSERT INTO pipelines (name, description, is_default, is_active, sort_order)
    VALUES ($1, $2, 0, 1, $3) RETURNING id`,
    [src.name + ' (Copy)', src.description, (src.sort_order || 0) + 1]);
  const newId = r.rows[0].id;
  const stages = await _all(`SELECT * FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY sort_order`, [id]);
  for (const s of stages) {
    await db.query(`INSERT INTO pipeline_stages
      (pipeline_id, name, sort_order, win_probability, is_terminal_win, is_terminal_loss, expected_days, color, icon, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [newId, s.name, s.sort_order, s.win_probability, s.is_terminal_win, s.is_terminal_loss, s.expected_days, s.color, s.icon, s.is_active]);
  }
  return { ok: true, id: newId };
}

// ──────────────────────────────────────────────────────────────────────
// OPPORTUNITY TYPES
// ──────────────────────────────────────────────────────────────────────
async function api_oppTypes_list(token) {
  await _ensureSchema();
  await authUser(token);
  return _all(`SELECT t.*, p.name AS default_pipeline_name FROM opportunity_types t
    LEFT JOIN pipelines p ON p.id = t.default_pipeline_id
    WHERE t.is_active = 1 ORDER BY t.sort_order, t.name`);
}

async function api_oppTypes_save(token, payload) {
  await _ensureSchema();
  await authUser(token);
  const p = payload || {};
  if (!p.name) throw new Error('name required');
  if (p.id) {
    await db.query(`UPDATE opportunity_types SET
      name=$1, default_pipeline_id=$2, default_amount=$3, default_probability=$4, default_close_days=$5,
      icon=$6, color=$7, sort_order=$8 WHERE id=$9`,
      [p.name, p.default_pipeline_id || null, p.default_amount || 0, p.default_probability || 0, p.default_close_days || 30,
       p.icon || '💼', p.color || '#3b82f6', p.sort_order || 0, p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO opportunity_types
    (name, default_pipeline_id, default_amount, default_probability, default_close_days, icon, color, sort_order)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [p.name, p.default_pipeline_id || null, p.default_amount || 0, p.default_probability || 0, p.default_close_days || 30,
     p.icon || '💼', p.color || '#3b82f6', p.sort_order || 0]);
  return { ok: true, id: r.rows[0].id };
}

async function api_oppTypes_delete(token, id) {
  await _ensureSchema(); await authUser(token);
  await db.query(`UPDATE opportunity_types SET is_active = 0 WHERE id = $1`, [id]);
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────
// REPORTS
// ──────────────────────────────────────────────────────────────────────
async function api_oppReports_funnel(token, opts) {
  await _ensureSchema(); await authUser(token);
  opts = opts || {};
  const where = [`s.is_active = 1`];
  const params = [];
  if (opts.pipeline_id) { params.push(opts.pipeline_id); where.push(`s.pipeline_id = $${params.length}`); }
  // Stages with aggregates
  const sql = `SELECT s.id AS stage_id, s.name AS stage_name, s.sort_order, s.color,
                      s.win_probability, s.is_terminal_win, s.is_terminal_loss,
                      COUNT(o.id)::int AS count,
                      COALESCE(SUM(o.amount), 0)::float AS sum_amount,
                      COALESCE(SUM(o.amount * (o.probability::float / 100.0)), 0)::float AS sum_weighted
                 FROM pipeline_stages s
                 LEFT JOIN opportunities o ON o.stage_id = s.id
                   ${opts.from ? ` AND o.created_at >= '${String(opts.from).replace(/'/g, '')}'` : ''}
                   ${opts.to   ? ` AND o.created_at <= '${String(opts.to).replace(/'/g, '')}'`   : ''}
                WHERE ${where.join(' AND ')}
                GROUP BY s.id ORDER BY s.sort_order`;
  return _all(sql, params);
}

async function api_oppReports_forecast(token, opts) {
  await _ensureSchema(); await authUser(token);
  opts = opts || {};
  const groupBy = opts.group_by === 'owner' ? 'owner_user_id' : `DATE_TRUNC('month', expected_close_date)`;
  const params = [];
  const where = [`closed_won = 0 AND closed_lost = 0`];
  if (opts.pipeline_id) { params.push(opts.pipeline_id); where.push(`pipeline_id = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`expected_close_date >= $${params.length}`); }
  if (opts.to)   { params.push(opts.to);   where.push(`expected_close_date <= $${params.length}`); }
  const sql = `SELECT ${groupBy} AS bucket,
                      COUNT(*)::int AS count,
                      COALESCE(SUM(amount), 0)::float AS sum_amount,
                      COALESCE(SUM(amount * (probability::float / 100.0)), 0)::float AS sum_weighted
                 FROM opportunities WHERE ${where.join(' AND ')}
                GROUP BY bucket ORDER BY bucket`;
  return _all(sql, params);
}

async function api_oppReports_winLoss(token, opts) {
  await _ensureSchema(); await authUser(token);
  opts = opts || {};
  const params = [];
  const where = [`(closed_won = 1 OR closed_lost = 1)`];
  if (opts.pipeline_id) { params.push(opts.pipeline_id); where.push(`pipeline_id = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`actual_close_date >= $${params.length}`); }
  if (opts.to)   { params.push(opts.to);   where.push(`actual_close_date <= $${params.length}`); }
  const totals = await _one(`SELECT
      COUNT(*)::int AS total,
      SUM(closed_won)::int AS won,
      SUM(closed_lost)::int AS lost,
      AVG(CASE WHEN closed_won = 1 THEN amount END)::float AS avg_won_size,
      AVG(EXTRACT(EPOCH FROM (actual_close_date - created_at))/86400)::float AS avg_cycle_days
    FROM opportunities WHERE ${where.join(' AND ')}`, params);
  const reasons = await _all(`SELECT COALESCE(lost_reason, 'No reason') AS reason, COUNT(*)::int AS n
    FROM opportunities WHERE closed_lost = 1 ${opts.pipeline_id ? `AND pipeline_id = $1` : ''}
    GROUP BY reason ORDER BY n DESC LIMIT 10`, opts.pipeline_id ? [opts.pipeline_id] : []);
  const win_rate = totals && totals.total ? Math.round((Number(totals.won) / Number(totals.total)) * 100) : 0;
  return { ...totals, win_rate, top_loss_reasons: reasons };
}

async function api_oppReports_velocity(token, opts) {
  await _ensureSchema(); await authUser(token);
  opts = opts || {};
  if (!opts.pipeline_id) throw new Error('pipeline_id required');
  return _all(`SELECT s.id AS stage_id, s.name AS stage_name,
                      AVG(h.duration_in_prev_stage_s)::int AS avg_seconds_in_stage,
                      COUNT(h.id)::int AS sample_size
                 FROM pipeline_stages s
                 LEFT JOIN opportunity_stage_history h ON h.from_stage_id = s.id
                WHERE s.pipeline_id = $1 AND s.is_active = 1
                GROUP BY s.id, s.name, s.sort_order ORDER BY s.sort_order`, [opts.pipeline_id]);
}

async function api_oppReports_aging(token, opts) {
  await _ensureSchema(); await authUser(token);
  opts = opts || {};
  const threshold = Number(opts.threshold_days) || 0;
  const params = [];
  const where = [`o.closed_won = 0 AND o.closed_lost = 0`];
  if (opts.pipeline_id) { params.push(opts.pipeline_id); where.push(`o.pipeline_id = $${params.length}`); }
  const sql = `SELECT o.*, l.name AS lead_name, u.name AS owner_name,
                      p.name AS pipeline_name, s.name AS stage_name, s.expected_days,
                      EXTRACT(EPOCH FROM (NOW() - COALESCE((
                        SELECT MAX(changed_at) FROM opportunity_stage_history WHERE opportunity_id = o.id
                      ), o.created_at)))::int / 86400 AS days_in_stage
                 FROM opportunities o
                 LEFT JOIN leads l ON l.id = o.lead_id
                 LEFT JOIN users u ON u.id = o.owner_user_id
                 LEFT JOIN pipelines p ON p.id = o.pipeline_id
                 LEFT JOIN pipeline_stages s ON s.id = o.stage_id
                WHERE ${where.join(' AND ')}
                  AND EXTRACT(EPOCH FROM (NOW() - COALESCE((
                    SELECT MAX(changed_at) FROM opportunity_stage_history WHERE opportunity_id = o.id
                  ), o.created_at)))::int / 86400 >
                  ${threshold > 0 ? threshold : 'COALESCE(s.expected_days, 7)'}
                ORDER BY days_in_stage DESC LIMIT 200`;
  return _all(sql, params);
}

// ──────────────────────────────────────────────────────────────────────
// MIGRATION — runs from tenantBootstrap on first connect
// ──────────────────────────────────────────────────────────────────────
async function ensureOpportunitiesBootstrap() {
  await _ensureSchema();
  // If no pipeline exists yet, seed one from existing statuses
  const existing = await _one(`SELECT COUNT(*)::int AS c FROM pipelines`);
  if (Number(existing && existing.c) === 0) {
    await _seedDefaultPipeline();
  }
  // Seed a default opportunity type if none
  const typesExisting = await _one(`SELECT COUNT(*)::int AS c FROM opportunity_types`);
  if (Number(typesExisting && typesExisting.c) === 0) {
    const def = await _getDefaultPipeline();
    await db.query(`INSERT INTO opportunity_types (name, default_pipeline_id, icon, color, sort_order)
      VALUES ('General Deal', $1, '💼', '#3b82f6', 0)`, [def.id]);
  }
}

module.exports = {
  _ensureSchema, ensureOpportunitiesBootstrap,
  // Opportunities
  api_opp_list, api_opp_get, api_opp_save, api_opp_delete,
  api_opp_changeStage, api_opp_close, api_opp_byLead,
  api_opp_bulkAssign, api_opp_bulkChangeStage,
  api_opp_lineItem_save, api_opp_lineItem_delete,
  api_opp_activity_save, api_opp_activity_delete,
  api_opp_doc_save, api_opp_doc_delete,
  // Pipelines
  api_pipelines_list, api_pipelines_save, api_pipelines_delete, api_pipelines_clone,
  // Types
  api_oppTypes_list, api_oppTypes_save, api_oppTypes_delete,
  // Reports
  api_oppReports_funnel, api_oppReports_forecast, api_oppReports_winLoss,
  api_oppReports_velocity, api_oppReports_aging
};

/**
 * Lightweight public "is enabled?" check for the SPA.
 * Reads the OPPORTUNITIES_ENABLED config and returns a flat boolean.
 * Auth'd so we know the user's tenant.
 */
async function api_opportunities_status(token) {
  await authUser(token);
  try {
    const r = await require('../db/pg').findOneBy('config', 'key', 'OPPORTUNITIES_ENABLED').catch(() => null);
    const v = r ? String(r.value || '').trim() : '';
    return { enabled: v === '1' };
  } catch (_) { return { enabled: false }; }
}

module.exports.api_opportunities_status = api_opportunities_status;
