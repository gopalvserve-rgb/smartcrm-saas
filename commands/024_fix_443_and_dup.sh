#!/bin/bash
CONF=/etc/nginx/sites-available/crm.smartcrmsolution.com.conf
# 443 must also bind the explicit IP or the default-ssl vhost steals HTTPS traffic
sed -i 's|^\s*listen 443 ssl;.*|    listen 103.139.75.150:443 ssl; # managed by Certbot|' $CONF
echo "--- any OTHER vhost claiming crm.smartcrmsolution.com? ---"
grep -rln "crm.smartcrmsolution" /etc/nginx/ | grep -v sites-available/crm.smartcrmsolution.com.conf | grep -v sites-enabled
nginx -T 2>/dev/null | grep -n "crm.smartcrmsolution" | head
nginx -t && systemctl reload nginx
echo "--- external-style tests ---"
curl -s -o /dev/null -w "http  HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://103.139.75.150/config.json
curl -sk -o /dev/null -w "https HTTP %{http_code}\n" --resolve crm.smartcrmsolution.com:443:103.139.75.150 https://crm.smartcrmsolution.com/config.json
echo "--- restore progress ---"
grep -c "^restored" /root/smartcrm-migration/logs/final.log | xargs echo "databases restored so far:"
tail -3 /root/smartcrm-migration/logs/final.log
