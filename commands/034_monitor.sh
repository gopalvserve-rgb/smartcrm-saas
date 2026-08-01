#!/bin/bash
MAXSEEN=0; ERR=0
for i in $(seq 1 12); do
  C=$(docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity;" 2>/dev/null)
  [ -z "$C" ] && { ERR=$((ERR+1)); C="ERR"; }
  [ "$C" != "ERR" ] && [ "$C" -gt "$MAXSEEN" ] && MAXSEEN=$C
  H=$(curl -s -o /dev/null -w "%{http_code}" https://crm.smartcrmsolution.com/config.json)
  echo "t$((i*15))s conns=$C site=$H"
  sleep 15
done
echo "peak connections over 3min: $MAXSEEN / 400 ; connect-failures: $ERR"
free -h | head -2
