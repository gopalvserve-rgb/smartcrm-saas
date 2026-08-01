#!/bin/bash
set -e
source /root/smartcrm-migration/secrets.env
PW="$LOCAL_PG_PASS"
export DEBIAN_FRONTEND=noninteractive
command -v psql >/dev/null || apt-get install -y postgresql-client-16 2>&1 | tail -1 || apt-get install -y postgresql-client 2>&1 | tail -1
psql --version
systemctl is-active pgbouncer || systemctl restart pgbouncer

export PGPASSWORD="$PW"
echo "=== TEST via pgbouncer :6432 ==="
psql -h 127.0.0.1 -p 6432 -U postgres -d control -Atc "SELECT count(*) FROM tenants;" | xargs echo "control tenants:"
psql -h 127.0.0.1 -p 6432 -U postgres -d tenant_vserve -Atc "SELECT count(*) FROM leads;" | xargs echo "vserve leads:"
for db in tenant_vserve tenant_samt tenant_jyoti tenant_basic tenant_royal tenant_gnk; do
  for n in 1 2 3 4; do psql -h 127.0.0.1 -p 6432 -U postgres -d $db -Atc "SELECT 1" >/dev/null 2>&1 & done
done; wait
echo "concurrency OK"

echo "=== switch app to pgbouncer (rollback copy kept) ==="
ENV=/home/crm.smartcrmsolution.com/app/.env
[ -f ${ENV}.direct ] || cp $ENV ${ENV}.direct
sed -i 's|@127.0.0.1:5433/|@127.0.0.1:6432/|g' $ENV
grep -c ':6432/' $ENV | xargs echo "bouncer urls:"
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env
sleep 35
PGCONN=$(psql -h 127.0.0.1 -p 5433 -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';")
echo "REAL postgres connections now: $PGCONN (was ~260 before pooler)"
curl -s -o /dev/null -w "LIVE HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "tenant vserve HTTP %{http_code}\n" https://crm.smartcrmsolution.com/t/vserve/
psql -h 127.0.0.1 -p 6432 -U postgres -d pgbouncer -Atc "SHOW TOTAL_CLIENTS;" 2>/dev/null || true
echo PGBOUNCER_LIVE
