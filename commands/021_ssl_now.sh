#!/bin/bash
echo "--- sync progress ---"
tail -8 /root/smartcrm-migration/logs/final.log
du -sh /root/smartcrm-migration/dumps/final_* 2>/dev/null | tail -1
echo "--- issuing SSL ---"
certbot --nginx -d crm.smartcrmsolution.com --redirect -m gopalvserve@gmail.com --agree-tos --no-eff-email -n 2>&1 | tail -8
nginx -t && systemctl reload nginx
echo "--- https test (app may still be restoring; 502 is OK here, cert is what matters) ---"
curl -s -o /dev/null -w "https HTTP %{http_code} ssl_verify:%{ssl_verify_result}\n" https://crm.smartcrmsolution.com/config.json --resolve crm.smartcrmsolution.com:443:127.0.0.1
