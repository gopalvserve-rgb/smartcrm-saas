#!/bin/bash
# SmartCRM SaaS migration — stage 2: deploy code (Node 20, PM2, Apache vhost)
set -e
: "${GH_PAT:?set GH_PAT}"
APPDIR=/home/crm.smartcrmsolution.com/app
export PATH=/opt/node20/bin:$PATH

if [ -d "$APPDIR/.git" ]; then
  cd "$APPDIR" && git fetch origin main && git reset --hard origin/main
else
  git clone --branch main "https://${GH_PAT}@github.com/gopalvserve-rgb/smartcrm-saas.git" "$APPDIR"
  cd "$APPDIR"
fi
echo "deployed commit: $(git log -1 --oneline)"

# .env: point DB at the PG18 container (127.0.0.1:5433)
sed -e 's|@localhost:5432/|@127.0.0.1:5433/|g' \
  /root/smartcrm-migration/env.production > "$APPDIR/.env"
chmod 600 "$APPDIR/.env"
grep -c '=' "$APPDIR/.env" | xargs echo "env vars:"

npm install 2>&1 | tail -3

cat > "$APPDIR/pm2.config.js" <<'EOF'
module.exports = { apps: [{
  name: "smartcrm",
  cwd: "/home/crm.smartcrmsolution.com/app",
  script: "server.js",
  interpreter: "/opt/node20/bin/node",
  env: { NODE_ENV: "production" },
  max_memory_restart: "1500M",
  time: true
}]};
EOF

# nginx reverse-proxy vhost (nginx owns :80/:443 on this box — old sites untouched)
if [ -d /etc/nginx/sites-enabled ]; then CONF=/etc/nginx/sites-available/crm.smartcrmsolution.com.conf; LINK=1
elif [ -d /etc/nginx/conf.d ]; then CONF=/etc/nginx/conf.d/crm.smartcrmsolution.com.conf; LINK=0
else echo "NGINX_LAYOUT_UNKNOWN"; ls /etc/nginx; exit 1; fi

cat > "$CONF" <<'EOF'
server {
    listen 80;
    server_name crm.smartcrmsolution.com;
    client_max_body_size 100M;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
EOF
[ "$LINK" = 1 ] && ln -sf "$CONF" /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx && echo "VHOST=nginx OK ($CONF)"
echo "=== DEPLOY DONE (app starts after DB restore) ==="
