#!/bin/bash
sleep 5
echo "--- listener ---"; ss -tlnp | grep ':3000 ' || echo "no listener on 3000"
echo "--- pm2 smartcrm ---"; pm2 describe smartcrm 2>/dev/null | grep -E "status|restarts|uptime" | head -5
echo "--- direct ---"; curl -s -o /tmp/cfg.json -w "config.json HTTP %{http_code}\n" http://127.0.0.1:3000/config.json; head -c 200 /tmp/cfg.json 2>/dev/null; echo
echo "--- via nginx ---"; curl -s -o /dev/null -w "via-nginx HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://127.0.0.1/config.json
echo "--- tenant page ---"; curl -s -o /dev/null -w "tenant login HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://127.0.0.1/t/vserve/
echo "--- app logs (last 25) ---"; tail -25 /root/.pm2/logs/smartcrm-out.log 2>/dev/null; tail -10 /root/.pm2/logs/smartcrm-error.log 2>/dev/null
