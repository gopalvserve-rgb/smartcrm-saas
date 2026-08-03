#!/bin/bash
echo "=== load average (2 cores) ==="; cat /proc/loadavg
echo "=== top CPU eaters ==="
ps aux --sort=-%cpu | head -12
echo "=== pm2 apps with restart counts ==="
pm2 list 2>/dev/null | grep -E "app|server|smartcrm|www|recharge"
echo "=== what do 'app' and 'recharge-server' point at? ==="
pm2 describe app 2>/dev/null | grep -E "script path|exec cwd|status" | head -3
pm2 describe recharge-server 2>/dev/null | grep -E "script path|exec cwd|status" | head -3
echo "=== their recent error (why crash-looping) ==="
tail -3 /root/.pm2/logs/app-error.log 2>/dev/null
tail -3 /root/.pm2/logs/recharge-server-error.log 2>/dev/null
