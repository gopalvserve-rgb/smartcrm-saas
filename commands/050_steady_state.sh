#!/bin/bash
echo "=== uptime since last restart ==="
pm2 describe smartcrm 2>/dev/null | grep -E "uptime|restarts" | head -2
echo "=== steady-state latency (no restart) ==="
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "config.json %{time_total}s / vserve " https://crm.smartcrmsolution.com/config.json
  curl -s -o /dev/null -w "%{time_total}s http=%{http_code}\n" https://crm.smartcrmsolution.com/t/vserve/
  sleep 5
done
echo "=== real PG conns (3 samples) ==="
for i in 1 2 3; do docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';"; sleep 10; done
echo "=== bootstrap still running? (recent log) ==="
tail -3 /root/.pm2/logs/smartcrm-out.log
echo "=== pool timeouts last 2 min ==="
B=$(grep -c "timeout exceeded when trying to connect" /root/.pm2/logs/smartcrm-error.log 2>/dev/null); sleep 60
N=$(grep -c "timeout exceeded when trying to connect" /root/.pm2/logs/smartcrm-error.log 2>/dev/null); echo "new timeouts in 60s: $((N-B))"
