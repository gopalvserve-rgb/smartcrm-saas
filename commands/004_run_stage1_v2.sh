#!/bin/bash
cd /root/smartcrm-migration || exit 1
export GH_PAT=$(git remote get-url origin | sed -E 's#https://([^@]+)@.*#\1#')
git fetch origin migration-scripts && git reset --hard origin/migration-scripts
bash run_stage1.sh
