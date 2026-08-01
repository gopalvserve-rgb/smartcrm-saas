#!/bin/bash
source /root/smartcrm-migration/secrets.env
# how many slow queries in the last ~2 min vs overall, and current latency
echo "=== slow API in last 60 log lines ==="
tail -60 /root/.pm2/logs/smartcrm-out.log | grep -c "PERF_SLOW_API" | xargs echo "slow entries (recent):"
echo "=== live latency samples (should be well under 1s warm) ==="
for i in 1 2 3; do
  curl -s -o /dev/null -w "config.json  total=%{time_total}s http=%{http_code}\n" https://crm.smartcrmsolution.com/config.json
  curl -s -o /dev/null -w "tenant vserve total=%{time_total}s http=%{http_code}\n" https://crm.smartcrmsolution.com/t/vserve/
  sleep 3
done
echo "=== real PG conns now ==="
docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';"
echo "=== persist pgbouncer + confirm autostart on reboot ==="
systemctl is-enabled pgbouncer; systemctl is-active pgbouncer
