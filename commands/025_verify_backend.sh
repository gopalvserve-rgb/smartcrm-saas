#!/bin/bash
grep -n "listen" /etc/nginx/sites-available/crm.smartcrmsolution.com.conf
pm2 jlist 2>/dev/null | python3 -c "import json,sys; [print(a['name'],a['pm2_env']['status']) for a in json.load(sys.stdin)]" 2>/dev/null | head
ss -tlnp | grep ':3000 ' || echo "no 3000 listener"
echo "--- https body sample ---"
curl -sk --resolve crm.smartcrmsolution.com:443:103.139.75.150 https://crm.smartcrmsolution.com/config.json | head -c 200; echo
echo "--- cert subject ---"
curl -vsk --resolve crm.smartcrmsolution.com:443:103.139.75.150 https://crm.smartcrmsolution.com/ -o /dev/null 2>&1 | grep -E "subject:|issuer:"
echo "--- restore progress ---"
grep -c "^restored" /root/smartcrm-migration/logs/final.log | xargs echo "restored:"
