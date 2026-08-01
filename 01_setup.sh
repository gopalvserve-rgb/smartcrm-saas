#!/bin/bash
# SmartCRM SaaS migration — stage 1: audit + install stack (safe / non-destructive)
set -e
echo "=== AUDIT ==="
. /etc/os-release && echo "OS: $PRETTY_NAME"
echo "CPU: $(nproc) cores | RAM: $(free -h | awk '/Mem:/{print $2}') | Disk free: $(df -h / | awk 'NR==2{print $4}')"
echo "--- listening ports ---"
ss -tlnp | awk 'NR==1 || /:(80|443|3000|5432|8080|3306)\s/'
echo "--- existing web server ---"
systemctl is-active nginx 2>/dev/null && nginx -v 2>&1 || true
systemctl is-active apache2 2>/dev/null && apache2 -v 2>&1 | head -1 || true
systemctl is-active httpd 2>/dev/null || true
echo "--- existing node/pg ---"
node -v 2>/dev/null || echo "node: none"
psql --version 2>/dev/null || echo "psql: none"
pm2 -v 2>/dev/null || echo "pm2: none"
ls /etc/nginx/sites-enabled/ 2>/dev/null || true
ls /etc/apache2/sites-enabled/ 2>/dev/null || true
echo "=== AUDIT DONE ==="

if [ "$1" != "install" ]; then exit 0; fi

echo "=== INSTALL ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y

# Node 20 (NodeSource) if missing or < 20
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3 | tr -d .)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# PostgreSQL 18 from PGDG (matches Railway's postgres:18)
if ! command -v psql >/dev/null || ! psql --version | grep -qE ' 1[89]'; then
  apt-get install -y curl ca-certificates gnupg lsb-release
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
  apt-get install -y postgresql-18
fi
systemctl enable --now postgresql

apt-get install -y ffmpeg git nginx certbot python3-certbot-nginx
npm install -g pm2 >/dev/null

echo "=== VERSIONS ==="
node -v; psql --version; ffmpeg -version | head -1; nginx -v 2>&1; pm2 -v
echo "=== INSTALL DONE ==="
