#!/bin/bash
echo "--- DNS checks ---"
for NS in 8.8.8.8 1.1.1.1; do echo -n "@$NS: "; dig +short crm.smartcrmsolution.com @$NS | tail -1; done
echo "--- final sync progress ---"
tail -15 /root/smartcrm-migration/logs/final.log 2>/dev/null
echo "--- dump dir size so far ---"
du -sh /root/smartcrm-migration/dumps/final_* 2>/dev/null | tail -1
