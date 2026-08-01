#!/bin/bash
# claude-ops agent — lets Claude operate this server via the private GitHub repo.
# Polls branch "claude-ops": runs new commands/<id>.sh, pushes results/<id>.log back.
# Also auto-deploys /opt/smartcrm-saas whenever origin/main changes (like Railway).
REPO_DIR=/opt/claude-ops/repo
BRANCH=claude-ops
APPDIR=/opt/smartcrm-saas

sync_push() {
  cd "$REPO_DIR" || return 1
  for i in 1 2 3 4 5; do
    git pull --rebase origin $BRANCH >/dev/null 2>&1
    git push origin $BRANCH >/dev/null 2>&1 && return 0
    sleep 3
  done
}

while true; do
  cd "$REPO_DIR" || { sleep 30; continue; }
  git fetch origin $BRANCH >/dev/null 2>&1
  git pull --rebase origin $BRANCH >/dev/null 2>&1 || git rebase --abort >/dev/null 2>&1
  mkdir -p commands results

  # --- run any new command scripts ---
  for f in commands/*.sh; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .sh)
    if [ ! -e "results/$id.log" ]; then
      echo "[claude-ops] running $id at $(date)"
      timeout 3600 bash "$f" > "results/$id.log" 2>&1
      echo "---exit=$?---" >> "results/$id.log"
      git add results >/dev/null 2>&1
      git -c user.email=ops@server -c user.name=claude-ops commit -m "result: $id" >/dev/null 2>&1
      sync_push
    fi
  done

  # --- auto-deploy app when main changes (only if app already deployed+running) ---
  if [ -d "$APPDIR/.git" ] && [ -f /opt/claude-ops/autodeploy.on ]; then
    NEW=$(git ls-remote origin -h refs/heads/main 2>/dev/null | cut -f1)
    CUR=$(cat /opt/claude-ops/deployed_sha 2>/dev/null || true)
    if [ -n "$NEW" ] && [ "$NEW" != "$CUR" ]; then
      echo "[claude-ops] auto-deploy $NEW at $(date)"
      ( cd "$APPDIR" && git fetch origin main && git reset --hard origin/main \
        && npm install >/dev/null 2>&1 ; pm2 restart smartcrm >/dev/null 2>&1 )
      echo "$NEW" > /opt/claude-ops/deployed_sha
      echo "deployed $NEW at $(date)" >> "$REPO_DIR/results/_autodeploy.log"
      cd "$REPO_DIR" && git add results >/dev/null 2>&1 \
        && git -c user.email=ops@server -c user.name=claude-ops commit -m "autodeploy $NEW" >/dev/null 2>&1 && sync_push
    fi
  fi
  sleep 20
done
