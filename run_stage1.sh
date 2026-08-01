#!/bin/bash
# SmartCRM SaaS migration — STAGE 1 orchestrator (no downtime, Railway untouched)
# v2: secrets never echoed into logs; logs sanitized before push.
WORKDIR=/root/smartcrm-migration
cd "$WORKDIR"
mkdir -p logs
LOG="logs/stage1_$(date +%Y%m%d_%H%M%S).log"

# decrypt secrets (quiet — outside any tracing)
if [ ! -f secrets.env ]; then
  : "${MIG_KEY:?MIG_KEY env var required}"
  openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:$MIG_KEY -in secrets_bundle.tar.gz.enc | tar xz
fi
chmod 600 env.production secrets.env
set -a; source ./secrets.env; set +a

sanitize_logs() {
  for f in logs/*.log; do
    [ -f "$f" ] || continue
    for s in "$GH_PAT" "$PGPASSWORD_RAILWAY" "$LOCAL_PG_PASS"; do
      [ -n "$s" ] && sed -i "s|$s|[REDACTED]|g" "$f"
    done
    sed -i -E 's/ghp_[A-Za-z0-9]{30,}/[REDACTED]/g; s/(postgres(ql)?:\/\/[^:]+:)[^@]+@/\1[REDACTED]@/g' "$f"
  done
}
push_logs() {
  cd "$WORKDIR"
  sanitize_logs
  git add logs >/dev/null 2>&1
  git -c user.email=server@migration -c user.name=server commit -m "stage1 logs $(date +%H:%M:%S)" >/dev/null 2>&1
  git push origin HEAD >/dev/null 2>&1 && echo "[logs pushed]"
}
trap push_logs EXIT

{
echo "########## 0. CLAUDE-OPS AGENT ##########"
systemctl is-active claude-ops || bash 00_install_agent.sh || echo "WARN agent"

echo "########## 1+2. AUDIT & INSTALL ##########"
bash 01_setup.sh install || exit 1

echo "########## 3. DEPLOY CODE ##########"
bash 02_deploy.sh || exit 1

echo "########## 4. TRIAL DB COPY (Railway stays live) ##########"
bash 03_db_sync.sh || exit 1

echo "########## 5. START APP ##########"
cd /opt/smartcrm-saas
export PATH=/opt/node20/bin:$PATH
pm2 delete smartcrm >/dev/null 2>&1 || true
pm2 start pm2.config.js
pm2 save
sleep 8

echo "########## 6. SELF-TEST ##########"
curl -s -o /dev/null -w "config.json HTTP %{http_code}\n" http://127.0.0.1:3000/config.json
curl -s -o /dev/null -w "via-apache HTTP %{http_code}\n" -H "Host: crm.smartcrmsolution.com" http://127.0.0.1/config.json
pm2 status | head -12
echo "########## STAGE 1 COMPLETE ##########"
} 2>&1 | tee "$LOG"
