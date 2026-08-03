#!/bin/bash
echo "=== CPU ==="
lscpu 2>/dev/null | grep -E "^Model name|^CPU\(s\)|^Thread|^Core|^Socket|MHz" | head -6
echo "=== MEMORY ==="
grep -E "MemTotal|SwapTotal" /proc/meminfo
free -h | head -3
echo "=== DISK ==="
df -h / | tail -1
lsblk -d -o NAME,SIZE,TYPE 2>/dev/null | head -5
echo "=== VIRTUALIZATION ==="
systemd-detect-virt 2>/dev/null
echo "=== CURRENT LOAD (2 cores) ==="
cat /proc/loadavg
uptime
echo "=== crash-loop apps state (cmd 053 outcome) ==="
pm2 list 2>/dev/null | grep -E "app |recharge|smartcrm|www|server "
echo "=== site health ==="
curl -s -o /dev/null -w "config %{time_total}s http=%{http_code} / " --max-time 30 https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "vserve %{time_total}s http=%{http_code}\n" --max-time 30 https://crm.smartcrmsolution.com/t/vserve/
