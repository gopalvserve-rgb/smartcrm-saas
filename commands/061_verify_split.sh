#!/bin/bash
export PATH=/opt/node20/bin:$PATH
echo "=== fleet ==="
pm2 list | grep -E "smartcrm" | head -8
echo "=== ports ==="
for P in 3000 3001 3002 3003 3010; do
  C=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://127.0.0.1:$P/config.json)
  echo "port $P: $C"
done
echo "=== split correctness ==="
grep -l "background workers DISABLED" /root/.pm2/logs/smartcrm-web-*-out.log 2>/dev/null | wc -l | xargs echo "web procs with workers disabled:"
grep -c "campaign sender started" /root/.pm2/logs/smartcrm-worker-out.log 2>/dev/null | xargs echo "worker campaign starts:"
grep -c "campaign sender started" /root/.pm2/logs/smartcrm-web-0-out.log 2>/dev/null | xargs echo "web-0 campaign starts (must be 0):"
echo "=== LIVE speed ==="
for i in 1 2 3 4; do curl -s -o /dev/null -w "vserve %{time_total}s http=%{http_code}\n" --max-time 20 https://crm.smartcrmsolution.com/t/vserve/; sleep 3; done
curl -s -o /dev/null -w "config %{time_total}s http=%{http_code}\n" --max-time 20 https://crm.smartcrmsolution.com/config.json
echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"
