#!/bin/bash
# waits for the final-sync chain to bring the app up, then finalizes go-live
for i in $(seq 1 40); do
  grep -q "CUTOVER_APP_UP" /root/smartcrm-migration/logs/final.log 2>/dev/null && break
  sleep 15
done
tail -12 /root/smartcrm-migration/logs/final.log
echo "--- live checks over real HTTPS ---"
curl -s -o /dev/null -w "https config.json HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "tenant vserve HTTP %{http_code}\n" https://crm.smartcrmsolution.com/t/vserve/
curl -s -o /dev/null -w "http->https redirect HTTP %{http_code}\n" http://crm.smartcrmsolution.com/config.json
echo "--- enable autodeploy (push to main = live in ~20s) ---"
cd /home/crm.smartcrmsolution.com/app && git rev-parse origin/main > /opt/claude-ops/deployed_sha
touch /opt/claude-ops/autodeploy.on
echo "autodeploy ON"
pm2 save >/dev/null 2>&1
echo "GOLIVE_FINALIZED"
