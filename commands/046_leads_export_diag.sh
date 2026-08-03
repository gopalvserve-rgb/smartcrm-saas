#!/bin/bash
DB=tenant_vserve
echo "=== total leads in vserve ==="
docker exec smartcrm-pg psql -U postgres -d $DB -Atc "SELECT count(*) FROM leads;" | xargs echo "leads:"
echo "=== time a 5000-row fetch with typical joins (what export does) ==="
docker exec smartcrm-pg psql -U postgres -d $DB -Atc "\timing on" -c "
EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON)
SELECT l.* FROM leads l ORDER BY l.id DESC LIMIT 5000;" 2>&1 | grep -iE "Execution|Planning" 
echo "--- wall clock of the raw 5000 fetch ---"
START=$(date +%s%3N)
docker exec smartcrm-pg psql -U postgres -d $DB -Atc "SELECT l.id FROM leads l ORDER BY l.id DESC LIMIT 5000;" >/dev/null
END=$(date +%s%3N); echo "raw 5000 id fetch: $((END-START)) ms"
echo "=== recent api_leads_list slow/errors in app log ==="
grep -hE "api_leads_list|leads_list|export" /root/.pm2/logs/smartcrm-out.log /root/.pm2/logs/smartcrm-error.log 2>/dev/null | tail -12
echo "=== nginx limits for the vhost ==="
grep -iE "client_max_body|proxy_read_timeout|proxy_buffer" /etc/nginx/sites-available/crm.smartcrmsolution.com.conf
echo "=== app statement_timeout? ==="
grep -rn "statement_timeout\|query_timeout\|statementTimeout" /home/crm.smartcrmsolution.com/app/db/pg.js 2>/dev/null | head
