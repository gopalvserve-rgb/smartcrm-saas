#!/bin/bash
echo "--- nat PREROUTING (interception?) ---"
iptables -t nat -S PREROUTING 2>/dev/null | grep -E "80|443" | head -10
echo "--- nginx vhosts ---"
nginx -T 2>/dev/null | grep -nE "server_name|listen " | head -30
echo "--- includes ---"
grep -n "include" /etc/nginx/nginx.conf | head
echo "--- self-test via public IP ---"
curl -s -o /dev/null -w "pubIP+host HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://103.139.75.150/config.json
mkdir -p /var/www/html/.well-known/acme-challenge && echo probe123 > /var/www/html/.well-known/acme-challenge/probe.txt
curl -s -w "\nacme-path via pubIP: HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://103.139.75.150/.well-known/acme-challenge/probe.txt | tail -2
echo "--- bitninja ---"
systemctl is-active bitninja 2>/dev/null; ps aux | grep -i [b]itninja | head -3
