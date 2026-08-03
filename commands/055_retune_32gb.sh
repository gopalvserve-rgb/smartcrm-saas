#!/bin/bash
set -e
source /root/smartcrm-migration/secrets.env
echo "=== recreate PG container tuned for 32GB/16 cores ==="
docker rm -f smartcrm-pg
docker run -d --name smartcrm-pg --restart unless-stopped \
  -e POSTGRES_PASSWORD="$LOCAL_PG_PASS" \
  -v /home/crm.smartcrmsolution.com/pgdata:/var/lib/postgresql \
  -v /root/smartcrm-migration/dumps:/dumps \
  -p 127.0.0.1:5433:5432 postgres:18 \
  -c max_connections=400 -c shared_buffers=4GB -c effective_cache_size=16GB \
  -c work_mem=16MB -c maintenance_work_mem=512MB \
  -c max_parallel_workers_per_gather=4 -c max_parallel_workers=8 -c max_worker_processes=16 \
  -c random_page_cost=1.1 -c superuser_reserved_connections=8 \
  -c idle_in_transaction_session_timeout=120000
for i in $(seq 1 30); do sleep 2; docker exec smartcrm-pg pg_isready -U postgres >/dev/null 2>&1 && break; done
docker exec smartcrm-pg psql -U postgres -Atc "show shared_buffers; show effective_cache_size; show max_connections;"
echo "=== restore generous app pools (plenty of RAM now) ==="
ENV=/home/crm.smartcrmsolution.com/app/.env
sed -i 's/^PG_POOL_LRU_MAX=.*/PG_POOL_LRU_MAX=130/' $ENV
sed -i 's/^PG_POOL_PER_TENANT_MAX=.*/PG_POOL_PER_TENANT_MAX=4/' $ENV
grep PG_POOL $ENV
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env >/dev/null 2>&1
echo "restarted; warming 45s..."; sleep 45
echo "=== verification ==="
curl -s -o /dev/null -w "config %{time_total}s http=%{http_code}\n" --max-time 30 https://crm.smartcrmsolution.com/config.json
for i in 1 2 3; do curl -s -o /dev/null -w "vserve %{time_total}s http=%{http_code}\n" --max-time 30 https://crm.smartcrmsolution.com/t/vserve/; sleep 4; done
docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity;" | xargs echo "PG conns:"
echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"; free -h | head -2
echo RETUNE_DONE
