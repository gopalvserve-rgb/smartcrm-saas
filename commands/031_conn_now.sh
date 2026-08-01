#!/bin/bash
docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*),(SELECT setting FROM pg_settings WHERE name='max_connections') FROM pg_stat_activity;" | xargs echo "conns/max:"
grep -c "too many clients" /root/.pm2/logs/smartcrm-error.log 2>/dev/null | xargs echo "too-many-clients errors in log:"
curl -s -o /dev/null -w "site HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
