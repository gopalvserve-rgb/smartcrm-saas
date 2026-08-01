#!/bin/bash
# Fix: sanitize logs before pushing (GitHub push-protection blocked pushes containing secrets)
set -u

# ---- 1. write new agent with sanitization ----
cat > /opt/claude-ops/agent.sh <<'AGENT'
#!/bin/bash
REPO_DIR=/opt/claude-ops/repo
BRANCH=claude-ops
APPDIR=/opt/smartcrm-saas

sanitize() { # redact secrets so GitHub push-protection never blocks
  local f="$1"; [ -f "$f" ] || return 0
  if [ -f /root/smartcrm-migration/secrets.env ]; then
    ( . /root/smartcrm-migration/secrets.env
      for s in "${GH_PAT:-}" "${PGPASSWORD_RAILWAY:-}" "${LOCAL_PG_PASS:-}"; do
        [ -n "$s" ] && sed -i "s|$s|[REDACTED]|g" "$f"
      done )
  fi
  sed -i -E 's/ghp_[A-Za-z0-9]{30,}/[REDACTED]/g; s/(postgres(ql)?:\/\/[^:]+:)[^@]+@/\1[REDACTED]@/g' "$f"
}

sync_push() {
  cd "$REPO_DIR" || return 1
  for i in 1 2 3 4 5; do
    git pull --rebase origin $BRANCH >/dev/null 2>&1 || git rebase --abort >/dev/null 2>&1
    git push origin $BRANCH >/dev/null 2>&1 && return 0
    sleep 3
  done
}

while true; do
  cd "$REPO_DIR" || { sleep 30; continue; }
  git fetch origin $BRANCH >/dev/null 2>&1
  git pull --rebase origin $BRANCH >/dev/null 2>&1 || git rebase --abort >/dev/null 2>&1
  mkdir -p commands results

  for f in commands/*.sh; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .sh)
    if [ ! -e "results/$id.log" ]; then
      echo "[claude-ops] running $id at $(date)"
      timeout 3600 bash "$f" > "results/$id.log" 2>&1
      echo "---exit=$?---" >> "results/$id.log"
      sanitize "results/$id.log"
      git add results >/dev/null 2>&1
      git -c user.email=ops@server -c user.name=claude-ops commit -m "result: $id" >/dev/null 2>&1
      sync_push
    fi
  done

  if [ -d "$APPDIR/.git" ] && [ -f /opt/claude-ops/autodeploy.on ]; then
    NEW=$(git ls-remote origin -h refs/heads/main 2>/dev/null | cut -f1)
    CUR=$(cat /opt/claude-ops/deployed_sha 2>/dev/null || true)
    if [ -n "$NEW" ] && [ "$NEW" != "$CUR" ]; then
      echo "[claude-ops] auto-deploy $NEW at $(date)"
      ( cd "$APPDIR" && git fetch origin main && git reset --hard origin/main \
        && PATH=/opt/node20/bin:$PATH npm install >/dev/null 2>&1 ; pm2 restart smartcrm >/dev/null 2>&1 )
      echo "$NEW" > /opt/claude-ops/deployed_sha
      echo "deployed $NEW at $(date)" >> "$REPO_DIR/results/_autodeploy.log"
      sanitize "$REPO_DIR/results/_autodeploy.log"
      cd "$REPO_DIR" && git add results >/dev/null 2>&1 \
        && git -c user.email=ops@server -c user.name=claude-ops commit -m "autodeploy $NEW" >/dev/null 2>&1 && sync_push
    fi
  fi
  sleep 20
done
AGENT
chmod +x /opt/claude-ops/agent.sh
echo "agent.sh rewritten with sanitization"

# ---- 2. unstick repo: drop the blocked (unsanitized) local commits ----
cd /opt/claude-ops/repo
git reset --hard origin/claude-ops
echo "repo reset to origin"

# ---- 3. restart service once (guarded against re-run loops) ----
if [ ! -f /opt/claude-ops/fix003.done ]; then
  touch /opt/claude-ops/fix003.done
  nohup bash -c 'sleep 10; systemctl restart claude-ops' >/dev/null 2>&1 &
  echo "restart scheduled"
else
  echo "restart already done earlier"
fi
echo "FIX003 OK"
