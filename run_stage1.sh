#!/bin/bash
# SmartCRM SaaS migration — STAGE 1 orchestrator (no downtime, Railway untouched)
# audit → install stack → deploy code → trial DB copy → start app → self-test
# Logs are committed back to the migration branch so Claude can review remotely.
WORKDIR=/root/smartcrm-migration
cd "$WORKDIR"
mkdir -p logs
LOG="logs/stage1_$(date +%Y%m%d_%H%M%S).log"

push_logs() {
  cd "$WORKDIR"
  git add -A logs >/dev/null 2>&1
  git -c user.email=server@migration -c user.name=server commit -m "stage1 logs $(date +%H:%M:%S)" >/dev/null 2>&1
  git push origin HEAD >/dev/null 2>&1 && echo "[logs pushed to GitHub]"
}
trap push_logs EXIT

: "${MIG_KEY:?MIG_KEY env var required (decryption key)}"
openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:$MIG_KEY -in secrets_bundle.tar.gz.enc | tar xz
chmod 600 env.production secrets.env

{
set -x
source ./secrets.env
export GH_PAT

echo "########## 1. AUDIT ##########"
bash 01_setup.sh || exit 1

echo "########## 2. INSTALL ##########"
bash 01_setup.sh install || exit 1

echo "########## 3. DEPLOY CODE ##########"
bash 02_deploy.sh || exit 1

echo "########## 4. TRIAL DB COPY (Railway stays live) ##########"
bash 03_db_sync.sh || exit 1

echo "########## 5. START APP ##########"
cd /opt/smartcrm-saas
node db/migrate.js || true
pm2 start pm2.config.js
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
sleep 8

echo "########## 6. SELF-TEST ##########"
curl -s -o /dev/null -w "config.json HTTP %{http_code}\n" http://127.0.0.1:3000/config.json
curl -s -o /dev/null -w "via-vhost HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://127.0.0.1/config.json
curl -s http://127.0.0.1:3000/config.json | head -c 300; echo
pm2 status
echo "########## STAGE 1 COMPLETE ##########"
} 2>&1 | tee "$LOG"
