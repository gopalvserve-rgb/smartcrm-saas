#!/bin/bash
# SmartCRM SaaS migration — DB sync from Railway to local PostgreSQL.
# Usage: PGPASSWORD_RAILWAY=... LOCAL_PG_PASS=... ./03_db_sync.sh
# Dumps control DB ("railway") + every tenant_* DB from Railway proxy and
# restores into local PostgreSQL. Safe to re-run (drops & recreates local DBs).
set -e
RHOST="metro.proxy.rlwy.net"; RPORT="26133"; RUSER="postgres"
: "${PGPASSWORD_RAILWAY:?set PGPASSWORD_RAILWAY}"
: "${LOCAL_PG_PASS:?set LOCAL_PG_PASS}"

DUMPDIR=/root/smartcrm-migration/dumps/$(date +%Y%m%d_%H%M%S)
mkdir -p "$DUMPDIR"

# Ensure local postgres superuser password matches .env (password is alphanumeric)
if command -v sudo >/dev/null 2>&1; then
  sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD '${LOCAL_PG_PASS}';" >/dev/null
else
  su -s /bin/bash postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD '${LOCAL_PG_PASS}';\"" >/dev/null
fi

export PGPASSWORD="$PGPASSWORD_RAILWAY"
echo "--- databases on Railway ---"
DBS=$(psql -h $RHOST -p $RPORT -U $RUSER -d railway -Atc \
  "SELECT datname FROM pg_database WHERE datname='railway' OR datname LIKE 'tenant_%' ORDER BY 1;")
echo "$DBS"

for DB in $DBS; do
  echo "=== dumping $DB ==="
  pg_dump -h $RHOST -p $RPORT -U $RUSER -d "$DB" -Fc --no-owner --no-acl -f "$DUMPDIR/$DB.dump"
  echo "    $(du -h "$DUMPDIR/$DB.dump" | cut -f1)"
done

export PGPASSWORD="$LOCAL_PG_PASS"
for DB in $DBS; do
  echo "=== restoring $DB locally ==="
  psql -h localhost -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid<>pg_backend_pid();" >/dev/null || true
  psql -h localhost -U postgres -d postgres -c "DROP DATABASE IF EXISTS \"$DB\";"
  psql -h localhost -U postgres -d postgres -c "CREATE DATABASE \"$DB\";"
  pg_restore -h localhost -U postgres -d "$DB" --no-owner --no-acl "$DUMPDIR/$DB.dump"
done

echo "=== verify row counts (control DB) ==="
export PGPASSWORD="$PGPASSWORD_RAILWAY"
R_TENANTS=$(psql -h $RHOST -p $RPORT -U $RUSER -d railway -Atc "SELECT count(*) FROM tenants;" 2>/dev/null || echo "?")
export PGPASSWORD="$LOCAL_PG_PASS"
L_TENANTS=$(psql -h localhost -U postgres -d railway -Atc "SELECT count(*) FROM tenants;" 2>/dev/null || echo "?")
echo "tenants: railway=$R_TENANTS local=$L_TENANTS"
echo "=== DB SYNC DONE — dumps kept in $DUMPDIR ==="
