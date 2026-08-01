#!/bin/bash
CONF=/etc/nginx/sites-available/crm.smartcrmsolution.com.conf
sed -i 's|^\s*listen 80;|    listen 103.139.75.150:80;|' $CONF
grep -n "listen" $CONF
nginx -t && systemctl reload nginx
echo "--- pubIP test (502 expected while app restoring/stopped) ---"
curl -s -o /dev/null -w "pubIP+host HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://103.139.75.150/config.json
echo "--- certbot retry ---"
certbot --nginx -d crm.smartcrmsolution.com --redirect -m gopalvserve@gmail.com --agree-tos --no-eff-email -n 2>&1 | tail -6
nginx -t && systemctl reload nginx
grep -n "listen\|ssl_certificate " $CONF | head
echo "--- sync progress ---"
tail -6 /root/smartcrm-migration/logs/final.log
