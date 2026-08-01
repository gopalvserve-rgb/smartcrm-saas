#!/bin/bash
cd /root/smartcrm-migration || exit 1
export GH_PAT=$(git remote get-url origin | sed -E 's#https://([^@]+)@.*#\1#')
git fetch origin migration-scripts && git reset --hard origin/migration-scripts
mkdir -p logs
nohup bash -c 'bash 04_final_sync.sh && cd /home/crm.smartcrmsolution.com/app && export PATH=/opt/node20/bin:$PATH && pm2 restart smartcrm && sleep 25 && curl -s -o /dev/null -w "direct HTTP %{http_code}\n" http://127.0.0.1:3000/config.json && curl -s -o /dev/null -w "nginx HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://127.0.0.1/config.json && echo CUTOVER_APP_UP' > /root/smartcrm-migration/logs/final.log 2>&1 &
echo "final sync launched (pid $!)"
