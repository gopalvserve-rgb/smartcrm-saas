#!/bin/bash
source /root/smartcrm-migration/secrets.env
PW="$LOCAL_PG_PASS"
echo "=== pgbouncer pools (admin console) ==="
PGPASSWORD="$PW" docker exec -e PGPASSWORD="$PW" smartcrm-pg sh -c "true" 2>/dev/null
# query pgbouncer admin via its own listen — use socket from host through nc? use container gw won't work.
# Instead sample real PG conns over 3 min + app errors:
MAX=0
for i in $(seq 1 9); do
  C=$(docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';")
  [ "$C" -gt "$MAX" ] && MAX=$C
  H=$(curl -s -o /dev/null -w "%{http_code}" https://crm.smartcrmsolution.com/config.json)
  echo "t$((i*20))s realPGconns=$C site=$H"
  sleep 20
done
echo "peak real PG conns over 3min: $MAX / 400"
echo "=== app errors related to pooling/transaction since switch ==="
tail -400 /root/.pm2/logs/smartcrm-error.log 2>/dev/null | grep -iE "prepared|transaction|pgbouncer|too many|terminat|ECONN|pool" | tail -8 || echo "none"
echo "=== recent app out log ==="
tail -4 /root/.pm2/logs/smartcrm-out.log
echo "=== pgbouncer service ==="; systemctl is-active pgbouncer
free -h | head -2
