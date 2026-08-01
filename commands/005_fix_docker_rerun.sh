#!/bin/bash
# update live agent APPDIR (path moved to /home/crm.smartcrmsolution.com/app)
sed -i 's|^APPDIR=.*|APPDIR=/home/crm.smartcrmsolution.com/app|' /opt/claude-ops/agent.sh
# clean failed container + restart docker to rebuild iptables chains
docker rm -f smartcrm-pg 2>/dev/null
systemctl restart docker; sleep 6
systemctl is-active docker || exit 1
# pull latest scripts and run full stage1
cd /root/smartcrm-migration || exit 1
export GH_PAT=$(git remote get-url origin | sed -E 's#https://([^@]+)@.*#\1#')
git fetch origin migration-scripts && git reset --hard origin/migration-scripts
bash run_stage1.sh
