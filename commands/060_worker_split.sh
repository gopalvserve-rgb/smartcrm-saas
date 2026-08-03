#!/bin/bash
set -e
APP=/home/crm.smartcrmsolution.com/app
export PATH=/opt/node20/bin:$PATH

echo "=== 1. ensure latest code (autodeploy may have already pulled) ==="
cd $APP && git fetch origin main -q && git reset -q --hard origin/main
git log -1 --oneline
grep -c "WORKERS_ON && " server.js | xargs echo "guards present:"

echo "=== 2. new pm2 topology ==="
cat > $APP/pm2.config.js <<'EOF'
const base = {
  cwd: "/home/crm.smartcrmsolution.com/app",
  script: "server.js",
  interpreter: "/opt/node20/bin/node",
  time: true
};
module.exports = { apps: [
  Object.assign({}, base, { name: "smartcrm-web-0", env: { NODE_ENV:"production", WORKERS:"off", PORT:"3000" }, max_memory_restart: "1200M" }),
  Object.assign({}, base, { name: "smartcrm-web-1", env: { NODE_ENV:"production", WORKERS:"off", PORT:"3001" }, max_memory_restart: "1200M" }),
  Object.assign({}, base, { name: "smartcrm-web-2", env: { NODE_ENV:"production", WORKERS:"off", PORT:"3002" }, max_memory_restart: "1200M" }),
  Object.assign({}, base, { name: "smartcrm-web-3", env: { NODE_ENV:"production", WORKERS:"off", PORT:"3003" }, max_memory_restart: "1200M" }),
  Object.assign({}, base, { name: "smartcrm-worker", env: { NODE_ENV:"production", WORKERS:"on",  PORT:"3010" }, max_memory_restart: "1500M" })
]};
EOF

echo "=== 3. nginx upstream (4 web backends) ==="
CONF=/etc/nginx/sites-available/crm.smartcrmsolution.com.conf
grep -q "upstream smartcrm_web" $CONF || sed -i '1i upstream smartcrm_web {\n    least_conn;\n    server 127.0.0.1:3000 max_fails=2 fail_timeout=5s;\n    server 127.0.0.1:3001 max_fails=2 fail_timeout=5s;\n    server 127.0.0.1:3002 max_fails=2 fail_timeout=5s;\n    server 127.0.0.1:3003 max_fails=2 fail_timeout=5s;\n}' $CONF
sed -i 's|proxy_pass http://127.0.0.1:3000;|proxy_pass http://smartcrm_web;|' $CONF
nginx -t

echo "=== 4. switch processes (staggered, keeps serving) ==="
pm2 start $APP/pm2.config.js --only smartcrm-worker
sleep 5
pm2 start $APP/pm2.config.js --only smartcrm-web-1
pm2 start $APP/pm2.config.js --only smartcrm-web-2
pm2 start $APP/pm2.config.js --only smartcrm-web-3
echo "waiting 60s for web-1..3 to finish booting before swapping port 3000..."
sleep 60
pm2 delete smartcrm >/dev/null 2>&1 || true
pm2 start $APP/pm2.config.js --only smartcrm-web-0
systemctl reload nginx
pm2 save

echo "=== 5. update autodeploy to restart the new fleet ==="
sed -i 's/pm2 restart smartcrm >\/dev\/null/pm2 restart smartcrm-web-0 smartcrm-web-1 smartcrm-web-2 smartcrm-web-3 smartcrm-worker >\/dev\/null/' /opt/claude-ops/agent.sh
systemctl restart claude-ops
echo "WORKER_SPLIT_APPLIED"
