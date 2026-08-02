#!/bin/bash
export PATH=/opt/node20/bin:$PATH
echo "=== media CDN hosts Meta hands back for media (IPv6-heavy) ==="
for H in lookaside.fbsbx.com scontent.xx.fbcdn.net; do
  echo "--- $H ---"
  getent ahosts $H 2>/dev/null | awk '{print $1}' | sort -u | head
done
echo ""
echo "=== default node fetch to media CDN, 6 tries (catch intermittent v6 pick) ==="
node -e '
const host="https://scontent.xx.fbcdn.net/";
(async()=>{for(let i=0;i<6;i++){try{const r=await fetch(host);console.log(i,"OK",r.status)}catch(e){console.log(i,"FAILED",e.cause?.code||e.message)}}})()
' 2>&1
echo ""
echo "=== SAME with ipv4-first (the proposed fix, tested only — no app change) ==="
node --dns-result-order=ipv4first -e '
const host="https://scontent.xx.fbcdn.net/";
(async()=>{for(let i=0;i<6;i++){try{const r=await fetch(host);console.log(i,"OK",r.status)}catch(e){console.log(i,"FAILED",e.cause?.code||e.message)}}})()
' 2>&1
