#!/bin/bash
echo "=== 1. outbound connectivity from server to Meta Graph ==="
curl -s -o /dev/null -w "graph.facebook.com HTTP %{http_code} (connect %{time_connect}s)\n" https://graph.facebook.com/v19.0/ --max-time 15 || echo "GRAPH UNREACHABLE"
echo "=== 2. connectivity to R2 (outbound media store) ==="
R2EP=$(grep -E '^R2_ENDPOINT=' /home/crm.smartcrmsolution.com/app/.env | cut -d= -f2-)
echo "R2_ENDPOINT=$R2EP"
curl -s -o /dev/null -w "R2 endpoint HTTP %{http_code}\n" "$R2EP" --max-time 15 || echo "R2 UNREACHABLE"
echo "=== 3. recent WA media errors in app log ==="
grep -hoE "\[/api/wa/media\][^\"]*|Meta media lookup failed[^\"]*|WhatsApp token not configured|wa-media GET\] error[^\"]*" /root/.pm2/logs/smartcrm-*.log 2>/dev/null | tail -15 || echo "no wa/media errors logged"
echo "=== 4. does a busy tenant have a WA token + recent media rows? (vserve) ==="
docker exec smartcrm-pg psql -U postgres -d tenant_vserve -Atc "SELECT count(*) FILTER (WHERE media_id IS NOT NULL) AS with_media, count(*) FILTER (WHERE message_type='unknown') AS unknown_type, count(*) AS total FROM whatsapp_messages WHERE created_at > NOW() - INTERVAL '7 days';" 2>/dev/null | xargs echo "vserve 7d [with_media unknown total]:"
docker exec smartcrm-pg psql -U postgres -d tenant_vserve -Atc "SELECT CASE WHEN value IS NULL OR value='' THEN 'MISSING' ELSE 'present(len='||length(value)||')' END FROM config WHERE key ILIKE '%WA%TOKEN%' OR key ILIKE '%whatsapp%token%' LIMIT 3;" 2>/dev/null | xargs echo "vserve WA token:"
echo "=== 5. message_type distribution last 7d (is 'unknown' spiking or normal?) ==="
docker exec smartcrm-pg psql -U postgres -d tenant_vserve -Atc "SELECT message_type||'='||count(*) FROM whatsapp_messages WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY message_type ORDER BY count(*) DESC LIMIT 12;" 2>/dev/null
