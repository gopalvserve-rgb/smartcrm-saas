#!/bin/bash
echo "=== DIAGNOSIS ==="
echo "--- OOM kills? ---"; dmesg 2>/dev/null | grep -i "out of memory\|killed process" | tail -5
echo "--- container state ---"; docker ps -a --filter name=smartcrm-pg --format '{{.Status}}'
echo "--- pg container logs tail ---"; docker logs --tail 8 smartcrm-pg 2>&1 | tail -8
echo "--- memory ---"; free -h | head -2

echo "=== RECOVER: sane PG memory, restart-safe ==="
source /root/smartcrm-migration/secrets.env
docker rm -f smartcrm-pg
# Conservative for a 6GB shared box: 256MB buffers, 250 conns, small work_mem,
# and container memory hard-limit so PG can never trigger a host OOM again.
docker run -d --name smartcrm-pg --restart unless-stopped \
  --memory=1400m --memory-swap=1400m \
  -e POSTGRES_PASSWORD="$LOCAL_PG_PASS" \
  -v /home/crm.smartcrmsolution.com/pgdata:/var/lib/postgresql \
  -v /root/smartcrm-migration/dumps:/dumps \
  -p 127.0.0.1:5433:5432 postgres:18 \
  -c max_connections=250 -c shared_buffers=256MB -c work_mem=8MB \
  -c maintenance_work_mem=64MB -c effective_cache_size=1GB \
  -c superuser_reserved_connections=8 -c idle_in_transaction_session_timeout=60000
for i in $(seq 1 30); do sleep 2; docker exec smartcrm-pg pg_isready -U postgres >/dev/null 2>&1 && break; done
docker exec smartcrm-pg psql -U postgres -Atc "show max_connections; show shared_buffers;"

echo "=== tighten app pools so boot burst stays small ==="
ENV=/home/crm.smartcrmsolution.com/app/.env
sed -i '/^PG_POOL_LRU_MAX=/d;/^PG_POOL_PER_TENANT_MAX=/d;/^PG_POOL_MAX=/d;/^PG_POOL_IDLE_MS=/d' $ENV
cat >> $ENV <<VARS
PG_POOL_LRU_MAX=35
PG_POOL_PER_TENANT_MAX=2
PG_POOL_MAX=6
VARS
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env
echo "waiting for boot settle..."
sleep 25
for t in 1 2 3; do
  C=$(docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity;")
  echo "connections: $C / 250"; sleep 20
done
curl -s -o /dev/null -w "LIVE site HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "tenant vserve HTTP %{http_code}\n" https://crm.smartcrmsolution.com/t/vserve/
free -h | head -2
echo RECOVERED
