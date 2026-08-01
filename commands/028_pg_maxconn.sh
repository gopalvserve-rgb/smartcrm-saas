#!/bin/bash
set -e
source /root/smartcrm-migration/secrets.env
docker rm -f smartcrm-pg
docker run -d --name smartcrm-pg --restart unless-stopped \
  -e POSTGRES_PASSWORD="$LOCAL_PG_PASS" \
  -v /home/crm.smartcrmsolution.com/pgdata:/var/lib/postgresql \
  -v /root/smartcrm-migration/dumps:/dumps \
  -p 127.0.0.1:5433:5432 postgres:18 \
  -c max_connections=300 -c shared_buffers=512MB
for i in $(seq 1 20); do sleep 2; docker exec smartcrm-pg pg_isready -U postgres >/dev/null 2>&1 && break; done
docker exec smartcrm-pg psql -U postgres -Atc "show max_connections; show shared_buffers;"
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env
sleep 20
curl -s -o /dev/null -w "local app HTTP %{http_code}\n" http://127.0.0.1:3000/config.json
docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity;" | xargs echo "current connections:"
tail -5 /root/.pm2/logs/smartcrm-out.log
