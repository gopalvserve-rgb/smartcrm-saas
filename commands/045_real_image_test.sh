#!/bin/bash
export PATH=/opt/node20/bin:$PATH
DB=tenant_vserve
echo "=== recent INBOUND image messages (real media_ids) ==="
docker exec smartcrm-pg psql -U postgres -d $DB -Atc "SELECT id||'|'||coalesce(media_id,'NULL')||'|'||created_at FROM whatsapp_messages WHERE message_type='image' AND media_id IS NOT NULL ORDER BY id DESC LIMIT 3;"
MID=$(docker exec smartcrm-pg psql -U postgres -d $DB -Atc "SELECT media_id FROM whatsapp_messages WHERE message_type='image' AND media_id IS NOT NULL ORDER BY id DESC LIMIT 1;")
echo "testing media_id=$MID"
echo "=== outbound media store (wa_chat_media) present + migrated? ==="
docker exec smartcrm-pg psql -U postgres -d $DB -Atc "SELECT count(*)||' rows, '||pg_size_pretty(coalesce(sum(octet_length(bytes)),0)) FROM wa_chat_media;" 2>&1 | xargs echo "wa_chat_media:"
echo "=== live 2-step Meta media resolve with the tenant's REAL token ==="
TOK=$(docker exec smartcrm-pg psql -U postgres -d $DB -Atc "SELECT value FROM config WHERE key ILIKE '%whatsapp%token%' OR key ILIKE '%wa%access%token%' OR key ILIKE '%wa_token%' ORDER BY length(value) DESC LIMIT 1;")
echo "token len: ${#TOK}"
if [ -n "$MID" ] && [ -n "$TOK" ]; then
node -e '
const mid=process.argv[1], tok=process.argv[2];
(async()=>{
  try{
    const m=await fetch("https://graph.facebook.com/v19.0/"+mid,{headers:{Authorization:"Bearer "+tok}});
    const j=await m.json();
    if(!m.ok){console.log("STEP1 FAIL http",m.status,JSON.stringify(j.error||j).slice(0,200));return;}
    console.log("STEP1 OK mime="+j.mime_type+" size="+j.file_size+" url_host="+(j.url?new URL(j.url).host:"none"));
    const b=await fetch(j.url,{headers:{Authorization:"Bearer "+tok}});
    console.log("STEP2 bytes http="+b.status+" len="+(b.headers.get("content-length")||"?"));
  }catch(e){console.log("EXCEPTION:",e.cause?.code||e.message)}
})();
' "$MID" "$TOK" 2>&1
else echo "no media_id or token to test"; fi
