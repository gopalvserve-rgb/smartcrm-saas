#!/bin/bash
export PATH=/opt/node20/bin:$PATH
pm2 stop app recharge-server 2>/dev/null
pm2 delete 5 2>/dev/null   # errored duplicate 'server'
pm2 save
echo "=== pm2 now ==="
pm2 list | grep -E "app|recharge|server|smartcrm|www"
echo "=== waiting 60s for load to fall ==="
sleep 60
echo "load: $(cat /proc/loadavg | cut -d' ' -f1-3)"
for i in 1 2 3; do
  curl -s -o /dev/null -w "config %{time_total}s / " --max-time 30 https://crm.smartcrmsolution.com/config.json
  curl -s -o /dev/null -w "vserve %{time_total}s http=%{http_code}\n" --max-time 30 https://crm.smartcrmsolution.com/t/vserve/
  sleep 5
done
sleep 45; echo "load after 2min: $(cat /proc/loadavg | cut -d' ' -f1-3)"
curl -s -o /dev/null -w "final vserve %{time_total}s http=%{http_code}\n" --max-time 30 https://crm.smartcrmsolution.com/t/vserve/
