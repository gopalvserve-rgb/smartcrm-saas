#!/bin/bash
set -e
source /root/smartcrm-migration/secrets.env
ENV=/home/crm.smartcrmsolution.com/app/.env
# constrain the app's pooling so a full-tenant sweep can't exhaust PG
grep -q '^PG_POOL_LRU_MAX='        $ENV || echo 'PG_POOL_LRU_MAX=50'        >> $ENV
grep -q '^PG_POOL_PER_TENANT_MAX=' $ENV || echo 'PG_POOL_PER_TENANT_MAX=3'  >> $ENV
grep -q '^PG_POOL_MAX='            $ENV || echo 'PG_POOL_MAX=8'              >> $ENV
# raise DB ceiling with generous margin (400) — RAM cost ~ small at these buffers
docker rm -f smartcrm-pg
docker run -d --name smartcrm-pg --restart unless-stopped \
  -e POSTGRES_PASSWORD="$LOCAL_PG_PASS" \
  -v /home/crm.smartcrmsolution.com/pgdata:/var/lib/postgresql \
  -v /root/smartcrm-migration/dumps:/dumps \
  -p 127.0.0.1:5433:5432 postgres:18 \
  -c max_connections=400 -c shared_buffers=768MB -c superuser_reserved_connections=10
for i in $(seq 1 25); do sleep 2; docker exec smartcrm-pg pg_isready -U postgres >/dev/null 2>&1 && break; done
docker exec smartcrm-pg psql -U postgres -Atc "show max_connections;"
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env
sleep 22
curl -s -o /dev/null -w "app HTTP %{http_code}\n" http://127.0.0.1:3000/config.json
docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*),(SELECT setting::int FROM pg_settings WHERE name='max_connections') FROM pg_stat_activity;" | xargs echo "connections used / max:"
echo "--- .env pool lines ---"; grep PG_POOL $ENV
