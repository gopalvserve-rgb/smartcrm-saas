#!/bin/bash
echo "== FULL AUDIT =="
cat /root/smartcrm-migration/logs/*.log | sed -n '1,60p'
echo "== extras =="
docker --version 2>/dev/null && docker ps 2>/dev/null | head -5 || echo "docker: none"
free -h | head -2; df -h / | tail -1; nproc
ss -tlnp | awk '{print $4,$6}' | grep -E ':(80|443|3000|5432|3306|8080)\b' 
apachectl -v 2>/dev/null | head -1
mysql --version 2>/dev/null || true
ls /etc/apache2/sites-enabled/ 2>/dev/null
which certbot 2>/dev/null || echo "certbot: none"
cat /etc/os-release | grep PRETTY
