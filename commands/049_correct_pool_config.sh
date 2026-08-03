#!/bin/bash
ENV=/home/crm.smartcrmsolution.com/app/.env
# Correct pgbouncer-aware config: FEW warm tenants, enough conns each.
sed -i 's/^PG_POOL_LRU_MAX=.*/PG_POOL_LRU_MAX=30/' $ENV
sed -i 's/^PG_POOL_PER_TENANT_MAX=.*/PG_POOL_PER_TENANT_MAX=5/' $ENV
echo "=== app pool config ==="; grep PG_POOL $ENV
# pgbouncer: modest per-db pool, fast idle release
sed -i 's/^default_pool_size = .*/default_pool_size = 8/' /etc/pgbouncer/pgbouncer.ini
sed -i 's/^server_idle_timeout = .*/server_idle_timeout = 20/' /etc/pgbouncer/pgbouncer.ini
systemctl reload pgbouncer 2>/dev/null || systemctl restart pgbouncer
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env >/dev/null 2>&1
echo "waiting 40s for warmup + idle release..."; sleep 40
echo "=== real PG conns (should settle LOW & stable, not climb) ==="
for i in 1 2 3 4; do docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';"; sleep 15; done
echo "=== vserve latency (target ~2s like before) ==="
for i in 1 2 3; do curl -s -o /dev/null -w "vserve HTTP %{http_code} in %{time_total}s\n" https://crm.smartcrmsolution.com/t/vserve/; done
echo "=== pool timeouts last 60s ==="
B=$(grep -c "timeout exceeded when trying to connect" /root/.pm2/logs/smartcrm-error.log 2>/dev/null); sleep 60
N=$(grep -c "timeout exceeded when trying to connect" /root/.pm2/logs/smartcrm-error.log 2>/dev/null); echo "new timeouts: $((N-B))"
free -h | head -2
