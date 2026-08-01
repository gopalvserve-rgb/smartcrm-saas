#!/bin/bash
cat > /root/smartcrm-migration/resume_work.sh <<'WORK'
#!/bin/bash
set -e
PEXTRA=""; docker exec smartcrm-pg psql -U postgres -Atc 'select 1' >/dev/null 2>&1 || PEXTRA="-p 5433"
TS=$(docker exec smartcrm-pg ls /dumps | sort | tail -1)
echo "resuming from dump set $TS"
for f in $(docker exec smartcrm-pg ls /dumps/$TS); do
  DB="${f%.dump}"
  EXISTS=$(docker exec smartcrm-pg psql $PEXTRA -U postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$DB'" || true)
  TABLES=0
  [ "$EXISTS" = "1" ] && TABLES=$(docker exec smartcrm-pg psql $PEXTRA -U postgres -d "$DB" -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind='r'" || echo 0)
  if [ "$EXISTS" != "1" ] || [ "$TABLES" -lt 3 ] || [ "$DB" = "tenant_udified" ]; then
    echo "=== restore $DB (exists=$EXISTS tables=$TABLES) ==="
    docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "DROP DATABASE IF EXISTS \"$DB\";"
    docker exec smartcrm-pg psql $PEXTRA -U postgres -d postgres -c "CREATE DATABASE \"$DB\";"
    docker exec smartcrm-pg pg_restore $PEXTRA -U postgres -d "$DB" --no-owner --no-acl "/dumps/$TS/$f"
  else
    echo "ok $DB ($TABLES tables)"
  fi
done
echo "=== all restored; starting app ==="
cd /home/crm.smartcrmsolution.com/app
export PATH=/opt/node20/bin:$PATH
pm2 delete smartcrm >/dev/null 2>&1 || true
pm2 start pm2.config.js && pm2 save
sleep 8
curl -s -o /dev/null -w "config.json HTTP %{http_code}\n" http://127.0.0.1:3000/config.json
curl -s -o /dev/null -w "via-nginx HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://127.0.0.1/config.json
pm2 status | head -10
echo "RESUME_COMPLETE"
WORK
chmod +x /root/smartcrm-migration/resume_work.sh
mkdir -p /root/smartcrm-migration/logs
nohup bash /root/smartcrm-migration/resume_work.sh > /root/smartcrm-migration/logs/resume.log 2>&1 &
echo "resume launched in background (pid $!)"
