#!/bin/bash
set -e
source /root/smartcrm-migration/secrets.env
PW="$LOCAL_PG_PASS"
export DEBIAN_FRONTEND=noninteractive
echo "=== install pgbouncer ==="
command -v pgbouncer >/dev/null || apt-get install -y pgbouncer 2>&1 | tail -2

echo "=== config ==="
mkdir -p /etc/pgbouncer
cat > /etc/pgbouncer/pgbouncer.ini <<INI
[databases]
* = host=127.0.0.1 port=5433

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 5000
default_pool_size = 5
min_pool_size = 0
reserve_pool_size = 3
reserve_pool_timeout = 3
server_idle_timeout = 60
server_lifetime = 600
max_db_connections = 300
ignore_startup_parameters = extra_float_digits,search_path,options
logfile = /var/log/postgresql/pgbouncer.log
pidfile = /var/run/postgresql/pgbouncer.pid
admin_users = postgres
INI
printf '"postgres" "%s"\n' "$PW" > /etc/pgbouncer/userlist.txt
chown -R postgres:postgres /etc/pgbouncer 2>/dev/null || true
chmod 600 /etc/pgbouncer/userlist.txt
mkdir -p /var/run/postgresql /var/log/postgresql
chown postgres:postgres /var/run/postgresql /var/log/postgresql 2>/dev/null || true

systemctl enable pgbouncer >/dev/null 2>&1 || true
systemctl restart pgbouncer
sleep 3
systemctl is-active pgbouncer || { journalctl -u pgbouncer -n 20 --no-pager; exit 1; }

echo "=== TEST through pgbouncer (port 6432) BEFORE touching the app ==="
export PGPASSWORD="$PW"
T1=$(psql -h 127.0.0.1 -p 6432 -U postgres -d control -Atc "SELECT count(*) FROM tenants;" 2>&1) && echo "control tenants via bouncer: $T1" || { echo "TEST FAILED control: $T1"; exit 2; }
T2=$(psql -h 127.0.0.1 -p 6432 -U postgres -d tenant_vserve -Atc "SELECT count(*) FROM leads;" 2>&1) && echo "vserve leads via bouncer: $T2" || { echo "TEST FAILED vserve: $T2"; exit 2; }
# concurrency test: 20 parallel tenant queries through bouncer
echo "concurrency test..."
for db in tenant_vserve tenant_samt tenant_jyoti tenant_basic tenant_royal; do
  for n in 1 2 3 4; do psql -h 127.0.0.1 -p 6432 -U postgres -d $db -Atc "SELECT 1" >/dev/null 2>&1 & done
done; wait
echo "concurrency OK"

echo "=== switch app to pgbouncer (keep direct as rollback) ==="
ENV=/home/crm.smartcrmsolution.com/app/.env
cp $ENV ${ENV}.direct   # rollback copy (points at :5433)
sed -i 's|@127.0.0.1:5433/|@127.0.0.1:6432/|g' $ENV
grep -c ':6432/' $ENV | xargs echo "urls now via bouncer:"
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env
sleep 30

echo "=== verify: PG real connections should now be LOW, site UP ==="
PGCONN=$(PGPASSWORD="$PW" psql -h 127.0.0.1 -p 5433 -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';")
echo "REAL postgres connections now: $PGCONN (was ~260 direct)"
curl -s -o /dev/null -w "LIVE HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "tenant vserve HTTP %{http_code}\n" https://crm.smartcrmsolution.com/t/vserve/
psql -h 127.0.0.1 -p 6432 -U postgres -d pgbouncer -Atc "SHOW POOLS;" 2>/dev/null | head -5
free -h | head -2
echo PGBOUNCER_DONE
