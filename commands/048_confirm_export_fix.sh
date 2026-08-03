#!/bin/bash
echo "=== warmup: repeat vserve load 4x (should drop after 1st) ==="
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "vserve load HTTP %{http_code} in %{time_total}s\n" https://crm.smartcrmsolution.com/t/vserve/
done
echo "=== pool timeouts in last 3 min ==="
BASE=$(grep -c "timeout exceeded when trying to connect" /root/.pm2/logs/smartcrm-error.log 2>/dev/null)
echo "watching 90s..."; sleep 90
NOW=$(grep -c "timeout exceeded when trying to connect" /root/.pm2/logs/smartcrm-error.log 2>/dev/null)
echo "new pool-timeout errors in 90s: $((NOW-BASE))"
echo "=== real PG conns settling (3 samples) ==="
for i in 1 2 3; do docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';"; sleep 15; done
echo "=== site + mem ==="
curl -s -o /dev/null -w "site HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
free -h | head -2
