#!/bin/bash
pm2 describe smartcrm 2>/dev/null | grep -E "status|uptime|restarts" | head -3
ss -tlnp | grep ':3000 ' >/dev/null && echo "listener: UP" || echo "listener: DOWN"
tail -5 /root/.pm2/logs/smartcrm-error.log 2>/dev/null
for i in 1 2 3; do
  curl -s -o /dev/null -w "config %{time_total}s http=%{http_code} / " --max-time 30 https://crm.smartcrmsolution.com/config.json
  curl -s -o /dev/null -w "vserve %{time_total}s http=%{http_code}\n" --max-time 30 https://crm.smartcrmsolution.com/t/vserve/
  sleep 6
done
docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity;" | xargs echo "PG conns:"
echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"
