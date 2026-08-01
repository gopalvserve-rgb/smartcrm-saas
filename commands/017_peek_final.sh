#!/bin/bash
tail -12 /root/smartcrm-migration/logs/final.log 2>/dev/null || echo "no log yet"
