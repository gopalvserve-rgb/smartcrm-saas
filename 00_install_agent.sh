#!/bin/bash
# Install the claude-ops agent service (gives Claude remote control via GitHub).
set -e
: "${GH_PAT:?set GH_PAT}"
mkdir -p /opt/claude-ops
cp "$(dirname "$0")/agent.sh" /opt/claude-ops/agent.sh
chmod +x /opt/claude-ops/agent.sh

if [ ! -d /opt/claude-ops/repo/.git ]; then
  git clone --single-branch -b claude-ops "https://${GH_PAT}@github.com/gopalvserve-rgb/smartcrm-saas.git" /opt/claude-ops/repo
fi
cd /opt/claude-ops/repo
git config user.email ops@server; git config user.name claude-ops

cat > /etc/systemd/system/claude-ops.service <<'EOF'
[Unit]
Description=Claude ops agent (GitHub command relay + autodeploy)
After=network-online.target
[Service]
ExecStart=/opt/claude-ops/agent.sh
Restart=always
RestartSec=10
User=root
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now claude-ops
sleep 2
systemctl is-active claude-ops && echo "CLAUDE-OPS AGENT RUNNING"
