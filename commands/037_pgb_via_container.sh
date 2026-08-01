#!/bin/bash
set -e
source /root/smartcrm-migration/secrets.env
PW="$LOCAL_PG_PASS"
systemctl is-active pgbouncer || systemctl restart pgbouncer
# host IP as seen from inside the container (docker bridge gateway)
GW=$(docker exec smartcrm-pg sh -c "ip route | awk '/default/{print \$3}'" 2>/dev/null)
[ -z "$GW" ] && GW=172.17.0.1
echo "container->host gateway: $GW"
BQ() { docker exec -e PGPASSWORD="$PW" smartcrm-pg psql -h "$GW" -p 6432 -U postgres -d "$1" -Atc "$2"; }

echo "=== TEST via pgbouncer ==="
BQ control "SELECT count(*) FROM tenants;" | xargs echo "control tenants:"
BQ tenant_vserve "SELECT count(*) FROM leads;" | xargs echo "vserve leads:"
for db in tenant_vserve tenant_samt tenant_jyoti tenant_basic tenant_royal tenant_gnk; do
  for n in 1 2 3; do docker exec -e PGPASSWORD="$PW" smartcrm-pg psql -h "$GW" -p 6432 -U postgres -d $db -Atc "SELECT 1" >/dev/null 2>&1 & done
done; wait
echo "concurrency OK"

echo "=== switch app to pgbouncer (rollback copy kept at .env.direct) ==="
ENV=/home/crm.smartcrmsolution.com/app/.env
[ -f ${ENV}.direct ] || cp $ENV ${ENV}.direct
# app runs on host, so it reaches pgbouncer at 127.0.0.1:6432
sed -i 's|@127.0.0.1:5433/|@127.0.0.1:6432/|g' $ENV
grep -c ':6432/' $ENV | xargs echo "bouncer urls in .env:"
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env
sleep 35
PGCONN=$(docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';")
echo "REAL postgres connections now: $PGCONN  (was ~260 before pooler)"
curl -s -o /dev/null -w "LIVE HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "tenant vserve HTTP %{http_code}\n" https://crm.smartcrmsolution.com/t/vserve/
echo PGBOUNCER_LIVE
