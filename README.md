# SmartCRM SaaS

Multi-tenant SaaS CRM platform. One Node process, one Postgres cluster, one DB per tenant. Cashfree for billing.

```
crm.smartcrmsolution.com           → public landing + pricing
crm.smartcrmsolution.com/admin/    → super-admin panel
crm.smartcrmsolution.com/t/<slug>  → tenant CRM workspace
```

## Architecture

- **Control plane DB** (`smartcrm_control`) — packages, tenants, invoices, payments, super-admins, audit log
- **Tenant DBs** (`tenant_<slug>`) — auto-created on signup, run the same schema as `db/schema.sql`
- **Single process** routes requests by URL path; tenant resolver injects the right DB connection
- **Cashfree** — Hosted Checkout, webhook signs payments → automatic provisioning

## Setup

```bash
npm install
cp .env.example .env             # fill in CONTROL_DATABASE_URL + JWT_SECRET
npm run migrate:control          # creates control schema
npm run seed:control             # creates default packages + super-admin
npm start
```

The seed script creates the four packages from smartcrmsolution.com (Starter / Growth / Pro / Business) and one super-admin (default `admin@smartcrmsolution.com` — password printed to console).

## Deploy on Railway

1. Create a Postgres add-on, copy the URL into `CONTROL_DATABASE_URL`
2. Set env vars from `.env.example`
3. `railway up`
4. Point `crm.smartcrmsolution.com` at the Railway service

## Phase status

- ✅ Phase 1 — Control schema, signup, Cashfree, provisioning, super-admin panel
- ⏳ Phase 2 — Tenant CRM SPA wiring (per-tenant DB injection)
- ⏳ Phase 3 — Module gating + quota enforcement
- ⏳ Phase 4 — Custom requirements UI inside tenant + announcement banners
- ⏳ Phase 5 — Cron + pending-deletion lifecycle

## Repo layout

```
control/         control-plane (schema, db helper, seed)
routes/saas/     SaaS-only APIs (packages, signup, tenants, invoices, settings, …)
public/saas/     public landing + super-admin SPA
utils/           tenantResolver, tenantPool, etc.
db/              tenant CRM schema (used per-tenant on provisioning)
public/          tenant CRM SPA (used per-tenant inside /t/<slug>)
server.js        single-process entry — Phase 1
server.tenant.js (legacy) original Stockbox single-tenant server, kept for Phase 2 reference
```
