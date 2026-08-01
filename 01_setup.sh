#!/bin/bash
# SmartCRM SaaS migration — stage 1: audit + install stack
# v2: tuned for Ubuntu 20.04 Virtualmin box with broken third-party repos.
#  - apt update failures tolerated
#  - Node 20 as standalone tarball in /opt/node20 (system Node 16 untouched)
#  - PostgreSQL 18 as Docker container on 127.0.0.1:5433 (nothing else touched)
set -e
echo "=== AUDIT ==="
. /etc/os-release && echo "OS: $PRETTY_NAME"
echo "CPU: $(nproc) cores | RAM: $(free -h | awk '/Mem:/{print $2}') | Disk free: $(df -h / | awk 'NR==2{print $4}')"
ss -tlnp | awk 'NR==1 || /:(80|443|3000|5432|5433|8080|3306)\s/' || true
node -v 2>/dev/null || true; pm2 -v 2>/dev/null || true
docker --version 2>/dev/null || echo "docker: none"
echo "=== AUDIT DONE ==="
[ "$1" != "install" ] && exit 0

echo "=== INSTALL ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y 2>&1 | tail -2 || true   # broken 3rd-party repos are fine

# --- Node 20 standalone (does NOT touch system node16) ---
if [ ! -x /opt/node20/bin/node ]; then
  NV=v20.19.4
  curl -fsSL "https://nodejs.org/dist/${NV}/node-${NV}-linux-x64.tar.xz" -o /tmp/node20.tar.xz
  mkdir -p /opt/node20
  tar -xJf /tmp/node20.tar.xz -C /opt/node20 --strip-components=1
  rm -f /tmp/node20.tar.xz
fi
/opt/node20/bin/node -v

# --- ffmpeg ---
command -v ffmpeg >/dev/null || apt-get install -y ffmpeg || true
ffmpeg -version 2>/dev/null | head -1 || echo "WARN: ffmpeg missing (recording playback transcode only)"

# --- Docker (repo already configured on this box) ---
if ! command -v docker >/dev/null; then
  apt-get install -y docker-ce docker-ce-cli containerd.io 2>&1 | tail -1 \
    || curl -fsSL https://get.docker.com | sh 2>&1 | tail -1
fi
systemctl enable --now docker
docker --version

# --- PostgreSQL 18 container on 127.0.0.1:5433 ---
source /root/smartcrm-migration/secrets.env
mkdir -p /home/crm.smartcrmsolution.com/pgdata /root/smartcrm-migration/dumps
if ! docker ps --format '{{.Names}}' | grep -q '^smartcrm-pg$'; then
  docker rm -f smartcrm-pg >/dev/null 2>&1 || true
  docker run -d --name smartcrm-pg --restart unless-stopped \
    -e POSTGRES_PASSWORD="$LOCAL_PG_PASS" -e POSTGRES_DB=railway \
    -v /home/crm.smartcrmsolution.com/pgdata:/var/lib/postgresql/data \
    -v /root/smartcrm-migration/dumps:/dumps \
    -p 127.0.0.1:5433:5432 postgres:18 \
  || { echo "bridge-net failed — using host network fallback"; docker rm -f smartcrm-pg >/dev/null 2>&1;
       docker run -d --name smartcrm-pg --restart unless-stopped --network host \
         -e POSTGRES_PASSWORD="$LOCAL_PG_PASS" -e POSTGRES_DB=railway \
         -v /home/crm.smartcrmsolution.com/pgdata:/var/lib/postgresql/data \
         -v /root/smartcrm-migration/dumps:/dumps \
         postgres:18 -c port=5433 -c listen_addresses=127.0.0.1 ; }
fi
sleep 8
docker exec smartcrm-pg pg_isready -U postgres >/dev/null 2>&1 && echo "PG18 ready (bridge 127.0.0.1:5433)" \
 || { docker exec smartcrm-pg pg_isready -U postgres -p 5433 && echo "PG18 ready (host-net 127.0.0.1:5433)"; }

# --- certbot (apache plugin; Virtualmin-friendly, used only at cutover) ---
command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-apache 2>&1 | tail -1 || true

echo "=== INSTALL DONE ==="
