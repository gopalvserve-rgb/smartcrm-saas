#!/bin/bash
export PATH=/opt/node20/bin:$PATH
echo "=== node version ==="; node -v
echo "=== does Node global fetch reach Meta? (curl said 400=reachable) ==="
node -e '
const u="https://graph.facebook.com/v19.0/";
fetch(u).then(r=>console.log("node fetch OK http",r.status))
.catch(e=>console.log("node fetch FAILED:", e.cause?.code||e.cause?.message||e.message))
' 2>&1
echo "=== IPv4 vs IPv6 to graph.facebook.com ==="
curl -4 -s -o /dev/null -w "curl -4 HTTP %{http_code}\n" https://graph.facebook.com/v19.0/ --max-time 10 || echo "v4 fail"
curl -6 -s -o /dev/null -w "curl -6 HTTP %{http_code}\n" https://graph.facebook.com/v19.0/ --max-time 10 2>/dev/null || echo "v6 fail/none"
echo "=== does server have IPv6? ==="
ip -6 addr show scope global 2>/dev/null | grep -c inet6 | xargs echo "global IPv6 addrs:"
echo "=== node resolve order test (undici happy-eyeballs) ==="
node -e 'const d=require("dns");d.lookup("graph.facebook.com",{all:true},(e,a)=>console.log(e?("dns err "+e.message):JSON.stringify(a)))' 2>&1
echo "=== direct media-style fetch test through node (temp meta host) ==="
node -e '
fetch("https://lookaside.fbsbx.com/",{}).then(r=>console.log("fbsbx node fetch http",r.status)).catch(e=>console.log("fbsbx node FAILED:",e.cause?.code||e.message))
' 2>&1
