#!/bin/bash
curl -s -o /dev/null -w "vserve %{time_total}s http=%{http_code}\n" --max-time 45 https://crm.smartcrmsolution.com/t/vserve/
docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';" | xargs echo "PG conns:"
pm2 describe smartcrm 2>/dev/null | grep -E "uptime|restarts" | head -2
tail -2 /root/.pm2/logs/smartcrm-out.log
