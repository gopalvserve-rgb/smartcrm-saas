#!/bin/bash
tail -25 /root/smartcrm-migration/logs/resume.log 2>/dev/null || echo "no log yet"
