#!/bin/bash
cd /root/smartcrm-migration || exit 1
export GH_PAT=$(git remote get-url origin | sed -E 's#https://([^@]+)@.*#\1#')
git fetch origin migration-scripts && git reset --hard origin/migration-scripts
echo "script version check: $(grep -c 'crm.smartcrmsolution.com/app' 02_deploy.sh) (must be >=1)"
echo "--- why container crashed ---"
docker logs --tail 25 smartcrm-pg 2>&1
docker rm -f smartcrm-pg 2>/dev/null
rm -rf /opt/smartcrm-pgdata /home/crm.smartcrmsolution.com/pgdata
pm2 delete smartcrm 2>/dev/null
mkdir -p /home/crm.smartcrmsolution.com
if [ -d /opt/smartcrm-saas ] && [ ! -d /home/crm.smartcrmsolution.com/app ]; then
  mv /opt/smartcrm-saas /home/crm.smartcrmsolution.com/app
  echo "app moved to /home/crm.smartcrmsolution.com/app"
fi
bash run_stage1.sh
