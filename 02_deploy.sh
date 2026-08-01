#!/bin/bash
# SmartCRM SaaS migration — stage 2: deploy code (fresh GitHub clone + PM2 + web vhost)
# Usage: GH_PAT=... ./02_deploy.sh
set -e
: "${GH_PAT:?set GH_PAT}"
APPDIR=/opt/smartcrm-saas

if [ -d "$APPDIR/.git" ]; then
  cd "$APPDIR" && git fetch origin main && git reset --hard origin/main
else
  git clone --branch main "https://${GH_PAT}@github.com/gopalvserve-rgb/smartcrm-saas.git" "$APPDIR"
  cd "$APPDIR"
fi
echo "deployed commit: $(git log -1 --oneline)"

cp /root/smartcrm-migration/env.production "$APPDIR/.env"
chmod 600 "$APPDIR/.env"

npm install 2>&1 | tail -3

cat > "$APPDIR/pm2.config.js" <<'EOF'
module.exports = { apps: [{
  name: "smartcrm",
  cwd: "/opt/smartcrm-saas",
  script: "server.js",
  env: { NODE_ENV: "production" },
  max_memory_restart: "1500M",
  time: true
}]};
EOF

# ---- web server vhost for crm.smartcrmsolution.com → 127.0.0.1:3000 ----
P80_OWNER=$(ss -tlnp 2>/dev/null | awk '/:80 /{print; exit}')
echo "port80: ${P80_OWNER:-free}"

if echo "$P80_OWNER" | grep -qi apache2; then
  echo "Apache owns port 80 — adding Apache reverse-proxy vhost (old site untouched)"
  a2enmod proxy proxy_http proxy_wstunnel headers rewrite >/dev/null 2>&1 || true
  cat > /etc/apache2/sites-available/crm.smartcrmsolution.com.conf <<'EOF'
<VirtualHost *:80>
    ServerName crm.smartcrmsolution.com
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:3000/$1 [P,L]
    LimitRequestBody 104857600
</VirtualHost>
EOF
  a2ensite crm.smartcrmsolution.com >/dev/null
  apachectl configtest && systemctl reload apache2
  echo "VHOST=apache"
elif echo "$P80_OWNER" | grep -qi nginx || [ -z "$P80_OWNER" ]; then
  echo "Using nginx vhost"
  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  cat > /etc/nginx/sites-available/crm.smartcrmsolution.com <<'EOF'
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
  ln -sf /etc/nginx/sites-available/crm.smartcrmsolution.com /etc/nginx/sites-enabled/
  nginx -t && systemctl enable --now nginx && systemctl reload nginx
  echo "VHOST=nginx"
else
  echo "VHOST=CONFLICT — port 80 owned by: $P80_OWNER (will resolve manually)"
fi
echo "=== DEPLOY DONE (app not started yet — starts after DB restore) ==="
