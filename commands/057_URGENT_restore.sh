#!/bin/bash
echo "=== backend port reachable? ==="
docker ps --filter name=smartcrm-pg --format '{{.Status}} {{.Ports}}'
(echo > /dev/tcp/127.0.0.1/5433) 2>/dev/null && echo "5433 OPEN" || echo "5433 CLOSED"
echo "=== restart pgbouncer cleanly ==="
systemctl restart pgbouncer; sleep 2; systemctl is-active pgbouncer
(echo > /dev/tcp/127.0.0.1/6432) 2>/dev/null && echo "6432 OPEN" || echo "6432 CLOSED"
echo "=== restart app ==="
export PATH=/opt/node20/bin:$PATH
pm2 restart smartcrm --update-env >/dev/null 2>&1
echo "waiting for boot (up to 150s)..."
for i in $(seq 1 30); do
  sleep 5
  C=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3000/config.json 2>/dev/null)
  [ "$C" = "200" ] && { echo "APP UP after $((i*5))s"; break; }
done
curl -s -o /dev/null -w "LIVE config %{time_total}s http=%{http_code}\n" --max-time 20 https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "LIVE vserve %{time_total}s http=%{http_code}\n" --max-time 20 https://crm.smartcrmsolution.com/t/vserve/
tail -3 /root/.pm2/logs/smartcrm-error.log
