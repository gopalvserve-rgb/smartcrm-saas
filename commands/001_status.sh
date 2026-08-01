#!/bin/bash
echo "== $(date) =="
systemctl is-active claude-ops
echo "--- stage1 processes ---"
pgrep -af "run_stage1|01_setup|02_deploy|03_db_sync|pg_dump|pg_restore|npm" | head
echo "--- latest stage1 log tail ---"
ls -la /root/smartcrm-migration/logs/ 2>/dev/null
tail -40 /root/smartcrm-migration/logs/*.log 2>/dev/null | tail -40
echo "--- versions ---"
node -v 2>/dev/null; psql --version 2>/dev/null; pm2 -v 2>/dev/null
