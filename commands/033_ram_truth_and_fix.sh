#!/bin/bash
echo "=== TRUE MEMORY ==="
grep MemTotal /proc/meminfo
echo "virt: $(systemd-detect-virt 2>/dev/null)"
echo "--- cgroup memory limit (VPS cap shows here) ---"
cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null
echo "--- physical DIMMs (needs dmidecode) ---"
dmidecode -t memory 2>/dev/null | grep -E "Size: [0-9]" | grep -v "No Module" | head
echo "--- nproc ---"; nproc

echo "=== APPLY: cover 128-tenant sweep, no container mem cap ==="
source /root/smartcrm-migration/secrets.env
MEMKB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
MEMGB=$((MEMKB/1024/1024))
echo "detected ${MEMGB}GB usable"
# scale shared_buffers/cache to real RAM, but keep it safe on the shared box
if   [ "$MEMGB" -ge 24 ]; then SB=4GB; EC=12GB; MAXC=600
elif [ "$MEMGB" -ge 12 ]; then SB=1GB; EC=4GB;  MAXC=500
else                            SB=384MB; EC=1536MB; MAXC=400; fi
echo "using shared_buffers=$SB effective_cache=$EC max_connections=$MAXC"
docker rm -f smartcrm-pg
docker run -d --name smartcrm-pg --restart unless-stopped \
  -e POSTGRES_PASSWORD="$LOCAL_PG_PASS" \
  -v /home/crm.smartcrmsolution.com/pgdata:/var/lib/postgresql \
  -v /root/smartcrm-migration/dumps:/dumps \
  -p 127.0.0.1:5433:5432 postgres:18 \
  -c max_connections=$MAXC -c shared_buffers=$SB -c effective_cache_size=$EC \
  -c work_mem=6MB -c maintenance_work_mem=128MB \
  -c superuser_reserved_connections=8 -c idle_in_transaction_session_timeout=120000
for i in $(seq 1 30); do sleep 2; docker exec smartcrm-pg pg_isready -U postgres >/dev/null 2>&1 && break; done
docker exec smartcrm-pg psql -U postgres -Atc "show max_connections; show shared_buffers;"

# app pools: keep enough warm to avoid churn, per_tenant=2 → worst 128*2=256 < MAXC
ENV=/home/crm.smartcrmsolution.com/app/.env
sed -i '/^PG_POOL_LRU_MAX=/d;/^PG_POOL_PER_TENANT_MAX=/d;/^PG_POOL_MAX=/d' $ENV
printf 'PG_POOL_LRU_MAX=130\nPG_POOL_PER_TENANT_MAX=2\nPG_POOL_MAX=10\n' >> $ENV
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env
sleep 30
for t in 1 2 3; do C=$(docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity;"); echo "conns: $C"; sleep 25; done
echo "too-many errors since restart:"; docker exec smartcrm-pg psql -U postgres -Atc "SELECT 1" >/dev/null 2>&1 && echo "PG reachable OK"
curl -s -o /dev/null -w "LIVE HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "tenant HTTP %{http_code}\n" https://crm.smartcrmsolution.com/t/vserve/
free -h | head -2
echo DONE
