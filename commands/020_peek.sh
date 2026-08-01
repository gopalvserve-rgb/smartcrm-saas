#!/bin/bash
tail -20 /root/smartcrm-migration/logs/final.log 2>/dev/null
du -sh /root/smartcrm-migration/dumps/final_* 2>/dev/null | tail -1
