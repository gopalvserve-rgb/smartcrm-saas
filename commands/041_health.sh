#!/bin/bash
curl -s -o /dev/null -w "site HTTP %{http_code} in %{time_total}s\n" https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "vserve HTTP %{http_code} in %{time_total}s\n" https://crm.smartcrmsolution.com/t/vserve/
docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';" | xargs echo "PG conns:"
systemctl is-active pgbouncer smartcrm 2>/dev/null | tr '\n' ' '; echo
pm2 describe smartcrm 2>/dev/null | grep -E "status|restarts" | head -2
free -h | head -2
