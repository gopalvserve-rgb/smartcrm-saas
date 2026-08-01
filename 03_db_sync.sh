#!/bin/bash
# SmartCRM SaaS migration — DB sync Railway → local PG18 docker container.
# All dump/restore runs INSIDE the postgres:18 container (matching client tools).
# Safe to re-run; used for trial copy AND final cutover sync.
set -e
RHOST="metro.proxy.rlwy.net"; RPORT="26133"; RUSER="postgres"
: "${PGPASSWORD_RAILWAY:?set PGPASSWORD_RAILWAY}"

TS=$(date +%Y%m%d_%H%M%S)
docker exec smartcrm-pg mkdir -p /dumps/$TS

echo "--- databases on Railway ---"
DBS=$(docker exec -e PGPASSWORD="$PGPASSWORD_RAILWAY" smartcrm-pg \
  psql -h $RHOST -p $RPORT -U $RUSER -d railway -Atc \
  "SELECT datname FROM pg_database WHERE datname='railway' OR datname LIKE 'tenant_%' ORDER BY 1;")
echo "$DBS"

for DB in $DBS; do
  echo "=== dump $DB ==="
  docker exec -e PGPASSWORD="$PGPASSWORD_RAILWAY" smartcrm-pg \
    pg_dump -h $RHOST -p $RPORT -U $RUSER -d "$DB" -Fc --no-owner --no-acl -f "/dumps/$TS/$DB.dump"
done
docker exec smartcrm-pg du -sh /dumps/$TS

for DB in $DBS; do
  echo "=== restore $DB ==="
  docker exec smartcrm-pg psql -U postgres -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid<>pg_backend_pid();" >/dev/null || true
  docker exec smartcrm-pg psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS \"$DB\";"
  docker exec smartcrm-pg psql -U postgres -d postgres -c "CREATE DATABASE \"$DB\";"
  docker exec smartcrm-pg pg_restore -U postgres -d "$DB" --no-owner --no-acl "/dumps/$TS/$DB.dump"
done

echo "=== verify tenants count (control DB) ==="
R=$(docker exec -e PGPASSWORD="$PGPASSWORD_RAILWAY" smartcrm-pg \
  psql -h $RHOST -p $RPORT -U $RUSER -d railway -Atc "SELECT count(*) FROM tenants;" 2>/dev/null || echo "?")
L=$(docker exec smartcrm-pg psql -U postgres -d railway -Atc "SELECT count(*) FROM tenants;" 2>/dev/null || echo "?")
echo "tenants: railway=$R local=$L"
[ "$R" = "$L" ] && echo "MATCH_OK" || echo "MISMATCH_CHECK"
echo "=== DB SYNC DONE (dumps in /root/smartcrm-migration/dumps/$TS) ==="
