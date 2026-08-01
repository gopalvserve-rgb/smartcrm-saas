#!/bin/bash
# SmartCRM SaaS migration — stage 2: deploy code (Node 20, PM2, Apache vhost)
set -e
: "${GH_PAT:?set GH_PAT}"
APPDIR=/opt/smartcrm-saas
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
  cwd: "/opt/smartcrm-saas",
  script: "server.js",
  interpreter: "/opt/node20/bin/node",
  env: { NODE_ENV: "production" },
  max_memory_restart: "1500M",
  time: true
}]};
EOF

# Apache reverse-proxy vhost (Virtualmin box — old sites untouched)
a2enmod proxy proxy_http proxy_wstunnel headers rewrite >/dev/null 2>&1 || true
cat > /etc/apache2/sites-available/crm.smartcrmsolution.com.conf <<'EOF'
<VirtualHost *:80>
    ServerName crm.smartcrmsolution.com
    ProxyPreserveHost On
    ProxyPass /.well-known/ !
    DocumentRoot /var/www/html
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:3000/$1 [P,L]
    LimitRequestBody 104857600
</VirtualHost>
EOF
a2ensite crm.smartcrmsolution.com >/dev/null 2>&1 || true
apachectl configtest && systemctl reload apache2 && echo "VHOST=apache OK"
echo "=== DEPLOY DONE (app starts after DB restore) ==="
