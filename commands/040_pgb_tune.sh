#!/bin/bash
source /root/smartcrm-migration/secrets.env
sed -i \
 -e 's/^default_pool_size = .*/default_pool_size = 12/' \
 -e 's/^server_idle_timeout = .*/server_idle_timeout = 30/' \
 -e 's/^reserve_pool_size = .*/reserve_pool_size = 5/' \
 /etc/pgbouncer/pgbouncer.ini
grep -q "^query_wait_timeout" /etc/pgbouncer/pgbouncer.ini || sed -i '/^pool_mode/a query_wait_timeout = 20' /etc/pgbouncer/pgbouncer.ini
grep -q "^max_db_connections" /etc/pgbouncer/pgbouncer.ini && sed -i 's/^max_db_connections = .*/max_db_connections = 25/' /etc/pgbouncer/pgbouncer.ini
systemctl reload pgbouncer || systemctl restart pgbouncer
sleep 3
systemctl is-active pgbouncer
echo "=== monitor 3 min: latency + slow count + PG conns ==="
SLOW0=$(grep -c PERF_SLOW_API /root/.pm2/logs/smartcrm-out.log)
MAXT=0
for i in $(seq 1 9); do
  T=$(curl -s -o /dev/null -w "%{time_total}" -H "Host: crm.smartcrmsolution.com" http://127.0.0.1/t/vserve/)
  C=$(docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';")
  echo "t$((i*20))s vserve=${T}s realPGconns=$C"
  sleep 20
done
SLOW1=$(grep -c PERF_SLOW_API /root/.pm2/logs/smartcrm-out.log)
echo "new slow-API entries during window: $((SLOW1-SLOW0))"
curl -s -o /dev/null -w "final site HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
