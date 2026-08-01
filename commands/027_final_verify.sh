#!/bin/bash
grep -E "FINAL_SYNC_MATCH_OK|tenants railway=" /root/smartcrm-migration/logs/final.log
grep -c "^restored" /root/smartcrm-migration/logs/final.log | xargs echo "databases restored:"
curl -s https://crm.smartcrmsolution.com/config.json | head -c 150; echo
echo "--- workers alive ---"; tail -4 /root/.pm2/logs/smartcrm-out.log
free -h | head -2
