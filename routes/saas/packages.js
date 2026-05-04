/**
 * Packages — public listing for the pricing page + admin CRUD.
 */
const control = require('../../control/db');
const { authSuperAdmin, requireSuperAdmin } = require('./superAdminAuth');

/** Public — anyone can fetch the published, non-private packages. */
async function listPublic() {
  const r = await control.query(
    `SELECT id, name, description, base_price_inr, trial_days,
            recurring_period, recurring_period_count, is_lifetime,
            tax_percent, modules, show_modules_on_card, show_limits_on_card,
            quotas, max_instances, is_most_popular, sort_order
       FROM packages
      WHERE is_enabled = 1 AND is_private = 0
      ORDER BY sort_order ASC, base_price_inr ASC`
  );
  return r.rows;
}

/** Admin — full CRUD payload. */
async function listAll(token) {
  await requireSuperAdmin(token);
  const r = await control.query(`SELECT * FROM packages ORDER BY sort_order ASC, id ASC`);
  return r.rows;
}

async function getOne(token, id) {
  await requireSuperAdmin(token);
  return control.findById('packages', id);
}

const _editable = [
  'name', 'description', 'base_price_inr', 'trial_days',
  'recurring_period', 'recurring_period_count', 'is_lifetime',
  'tax_percent', 'allowed_payment_modes',
  'is_enabled', 'is_default', 'is_private', 'is_most_popular',
  'modules', 'show_modules_on_card', 'show_limits_on_card',
  'disabled_default_modules', 'hidden_tabs',
  'quotas', 'limitation_period',
  'max_instances', 'extra_instance_inr',
  'sort_order'
];

function _coerce(p) {
  const out = {};
  _editable.forEach(k => {
    if (p[k] !== undefined) out[k] = p[k];
  });
  // Stringify JSON for safety — Postgres accepts both, but explicit is clearer.
  if (out.quotas && typeof out.quotas === 'object') out.quotas = JSON.stringify(out.quotas);
  return out;
}

async function save(token, payload) {
  const me = await requireSuperAdmin(token);
  const p = payload || {};
  if (!p.name) throw new Error('Name is required');
  const data = _coerce(p);
  if (p.id) {
    await control.update('packages', p.id, data);
    return { id: Number(p.id), ok: true };
  }
  const id = await control.insert('packages', data);
  return { id, ok: true };
}

async function remove(token, id) {
  await requireSuperAdmin(token);
  // Soft-disable rather than DELETE so historical invoices keep their FK.
  await control.update('packages', id, { is_enabled: 0 });
  return { ok: true };
}

module.exports = {
  api_saas_packages_publicList: listPublic,
  api_saas_packages_list:       listAll,
  api_saas_packages_get:        getOne,
  api_saas_packages_save:       save,
  api_saas_packages_delete:     remove
};
