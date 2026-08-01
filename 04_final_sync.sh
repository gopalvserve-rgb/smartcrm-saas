#!/bin/bash
# FINAL CUTOVER SYNC — Railway app must already be stopped (no writes).
# Parallel dump (4 streams) + parallel restore (2) + rename railway→control.
set -e
source /root/smartcrm-migration/secrets.env
RHOST="metro.proxy.rlwy.net"; RPORT="26133"
PEXTRA=""; docker exec smartcrm-pg psql -U postgres -Atc 'select 1' >/dev/null 2>&1 || PEXTRA="-p 5433"
TS=final_$(date +%Y%m%d_%H%M%S)
docker exec smartcrm-pg mkdir -p /dumps/$TS

DBS=$(docker exec -e PGPASSWORD="$PGPASSWORD_RAILWAY" smartcrm-pg \
  psql -h $RHOST -p $RPORT -U postgres -d railway -Atc \
  "SELECT datname FROM pg_database WHERE datname='railway' OR datname LIKE 'tenant_%' ORDER BY pg_database_size(datname) DESC;")
echo "$DBS" | wc -l | xargs echo "databases to sync:"

echo "== parallel dump start $(date +%H:%M:%S) =="
echo "$DBS" | xargs -P 4 -I DBX docker exec -e PGPASSWORD="$PGPASSWORD_RAILWAY" smartcrm-pg \
  pg_dump -h $RHOST -p $RPORT -U postgres -d DBX -Fc --no-owner --no-acl -f /dumps/$TS/DBX.dump
echo "== dump done $(date +%H:%M:%S) =="
docker exec smartcrm-pg du -sh /dumps/$TS

restore_one() { true; }
echo "== parallel restore start $(date +%H:%M:%S) =="
echo "$DBS" | xargs -P 2 -I DBX bash -c '
  PEXTRA="'"$PEXTRA"'"; TS="'"$TS"'"
  docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='"'"'DBX'"'"' AND pid<>pg_backend_pid();" >/dev/null 2>&1
  docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "DROP DATABASE IF EXISTS \"DBX\";" >/dev/null
  docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "CREATE DATABASE \"DBX\";" >/dev/null
  docker exec smartcrm-pg pg_restore $PEXTRA -U postgres -d "DBX" --no-owner --no-acl /dumps/$TS/DBX.dump 2>&1 | tail -1
  echo "restored DBX"
'
echo "== restore done $(date +%H:%M:%S) =="

# rename control DB (railway → control; app SSL-detection workaround)
docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('railway','control') AND pid<>pg_backend_pid();" >/dev/null || true
docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "DROP DATABASE IF EXISTS control;"
docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "ALTER DATABASE railway RENAME TO control;"

R=$(docker exec -e PGPASSWORD="$PGPASSWORD_RAILWAY" smartcrm-pg psql -h $RHOST -p $RPORT -U postgres -d railway -Atc "SELECT count(*) FROM tenants;")
L=$(docker exec smartcrm-pg psql $PEXTRA -U postgres -d control -Atc "SELECT count(*) FROM tenants;")
echo "tenants railway=$R local=$L"; [ "$R" = "$L" ] && echo "FINAL_SYNC_MATCH_OK"
echo "== FINAL SYNC COMPLETE =="
