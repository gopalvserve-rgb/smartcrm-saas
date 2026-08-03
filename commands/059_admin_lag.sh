#!/bin/bash
echo "=== admin page + assets timing ==="
for i in 1 2 3; do
  curl -s -o /dev/null -w "admin html %{time_total}s http=%{http_code} size=%{size_download}\n" --max-time 40 https://crm.smartcrmsolution.com/admin/
  sleep 3
done
curl -s -o /dev/null -w "admin.js %{time_total}s http=%{http_code} size=%{size_download}\n" --max-time 40 "https://crm.smartcrmsolution.com/admin/admin.js"
echo "=== what is the Node process doing? ==="
pm2 describe smartcrm 2>/dev/null | grep -E "status|cpu|uptime" | head -4
ps -o pid,%cpu,%mem,etime,cmd -p $(pgrep -f "app/server.js" | head -1)
echo "=== event-loop pressure: sample 5 quick pings to a trivial endpoint ==="
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "%{time_total}s " --max-time 20 http://127.0.0.1:3000/config.json; done; echo
echo "=== what ran in the last 2 min (worker correlation) ==="
tail -30 /root/.pm2/logs/smartcrm-out.log | grep -vE "PERF_SLOW_API" | tail -12
echo "=== slow APIs last 2 min ==="
tail -40 /root/.pm2/logs/smartcrm-out.log | grep "PERF_SLOW_API" | tail -8
echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"
