#!/bin/bash
FAILS=0
for i in $(seq 1 10); do
  T=$(curl -s -o /dev/null -w "%{time_total}" --max-time 20 https://crm.smartcrmsolution.com/t/vserve/)
  H=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 https://crm.smartcrmsolution.com/config.json)
  [ "$H" != "200" ] && FAILS=$((FAILS+1))
  echo "t$((i*15))s vserve=${T}s config=$H"
  sleep 15
done
echo "failures: $FAILS/10"
echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"
docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity;" | xargs echo "PG conns:"
B=$(grep -c "timeout exceeded when trying to connect" /root/.pm2/logs/smartcrm-error.log 2>/dev/null); echo "pool-timeout total (baseline $B)"
free -h | head -2
