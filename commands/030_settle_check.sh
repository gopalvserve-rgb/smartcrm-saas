#!/bin/bash
for t in 0 30 60; do
  sleep $t
  C=$(docker exec smartcrm-pg psql -U postgres -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'tenant_%' OR datname='control';")
  echo "t+${t}s connections: $C / 400"
done
echo "--- super-admin dashboard endpoint test ---"
curl -s -o /dev/null -w "dashboard config HTTP %{http_code}\n" https://crm.smartcrmsolution.com/config.json
curl -s -o /dev/null -w "tenant vserve HTTP %{http_code}\n" https://crm.smartcrmsolution.com/t/vserve/
echo "--- any too-many-clients in logs since restart? ---"
grep -c "too many clients" /root/.pm2/logs/smartcrm-*.log 2>/dev/null | tail -2
free -h | head -2
