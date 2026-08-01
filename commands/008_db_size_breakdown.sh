#!/bin/bash
source /root/smartcrm-migration/secrets.env
RH="metro.proxy.rlwy.net"; RP="26133"
Q() { docker exec -e PGPASSWORD="$PGPASSWORD_RAILWAY" smartcrm-pg psql -h $RH -p $RP -U postgres -d "$1" -Atc "$2"; }
echo "== DATABASE SIZES ON RAILWAY (descending) =="
Q railway "SELECT rpad(datname,28)||' '||pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datistemplate=false ORDER BY pg_database_size(datname) DESC;"
echo
echo "== TOP TABLES IN 3 BIGGEST DBs =="
for DB in $(Q railway "SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY pg_database_size(datname) DESC LIMIT 3;"); do
  echo "--- $DB ---"
  Q "$DB" "SELECT rpad(relname,30)||' '||pg_size_pretty(pg_total_relation_size(c.oid))||'  rows~'||coalesce(reltuples::bigint,0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10;"
done
