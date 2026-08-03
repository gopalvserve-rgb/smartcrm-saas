#!/bin/bash
ENV=/home/crm.smartcrmsolution.com/app/.env
echo "=== before ==="; grep -E "PG_POOL" $ENV
# raise per-tenant pool (safe behind pgbouncer); keep others sane
sed -i 's/^PG_POOL_PER_TENANT_MAX=.*/PG_POOL_PER_TENANT_MAX=6/' $ENV
grep -q '^PG_POOL_CONN_TIMEOUT_MS=' $ENV || echo 'PG_POOL_CONN_TIMEOUT_MS=15000' >> $ENV
echo "=== after ==="; grep -E "PG_POOL" $ENV
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env >/dev/null 2>&1
sleep 18
echo "=== verify site + a heavy vserve leads fetch ==="
curl -s -o /dev/null -w "site HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "vserve leads page HTTP %{http_code} in %{time_total}s\n" https://crm.smartcrmsolution.com/t/vserve/
# simulate concurrency: 5 parallel heavy reads on vserve DB via pgbouncer path (proxy through app not possible w/o auth; check pool errors instead)
echo "=== any NEW pool timeouts after restart? (watch 30s) ==="
BASE=$(grep -c "timeout exceeded when trying to connect" /root/.pm2/logs/smartcrm-error.log 2>/dev/null)
sleep 30
NOW=$(grep -c "timeout exceeded when trying to connect" /root/.pm2/logs/smartcrm-error.log 2>/dev/null)
echo "new pool-timeout errors in last 30s: $((NOW-BASE))"
echo "=== real PG conns (pgbouncer keeps this low) ==="
docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';" | xargs echo "real PG conns:"
free -h | head -2
