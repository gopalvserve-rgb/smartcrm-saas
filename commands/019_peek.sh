#!/bin/bash
tail -18 /root/smartcrm-migration/logs/final.log 2>/dev/null
du -sh /root/smartcrm-migration/dumps/final_* 2>/dev/null | tail -1
echo -n "dns@8.8.8.8: "; dig +short crm.smartcrmsolution.com @8.8.8.8 | tail -1
