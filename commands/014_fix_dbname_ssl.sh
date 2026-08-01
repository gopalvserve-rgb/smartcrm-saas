#!/bin/bash
set -e
pm2 stop smartcrm >/dev/null 2>&1 || true
PEXTRA=""; docker exec smartcrm-pg psql -U postgres -Atc 'select 1' >/dev/null 2>&1 || PEXTRA="-p 5433"
docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='railway' AND pid<>pg_backend_pid();" || true
docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "DROP DATABASE IF EXISTS control;"
docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "ALTER DATABASE railway RENAME TO control;"
sed -i 's|5433/railway|5433/control|g' /home/crm.smartcrmsolution.com/app/.env
grep -c "5433/control" /home/crm.smartcrmsolution.com/app/.env | xargs echo "urls updated:"
pm2 restart smartcrm
echo "waiting for boot (control-plane migration on first start)..."
for i in $(seq 1 24); do
  sleep 5
  C=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/config.json || true)
  [ "$C" = "200" ] && break
done
echo "direct config.json HTTP $C after ~$((i*5))s"
curl -s -o /dev/null -w "via-nginx HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://127.0.0.1/config.json
curl -s -o /dev/null -w "tenant vserve HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://127.0.0.1/t/vserve/
docker exec smartcrm-pg psql $PEXTRA -U postgres -d control -Atc "SELECT count(*) FROM tenants;" | xargs echo "tenants in control DB:"
tail -8 /root/.pm2/logs/smartcrm-out.log
