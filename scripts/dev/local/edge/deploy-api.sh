#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Deploys the backend stack to the VPS: ensures Docker is
# installed (idempotent), rsyncs backend/ to /root/putcafe/api, rebuilds and
# (re)starts the compose stack, then health-checks both services publicly.
#
#   ./scripts/dev/local/edge/deploy-api.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
remote_dir="$(cd "$here/../../remote/edge" && pwd)"
log() { printf '\033[1;35m[putcafe-api]\033[0m %s\n' "$*"; }

# shellcheck source=_conn.sh
source "$here/_conn.sh"

log "ensuring docker on the VPS (idempotent)"
scp_ "$remote_dir/setup-api.sh" "$CONN_USER@$CONN_IP:/root/putcafe/setup-api.sh"
ssh_ 'bash /root/putcafe/setup-api.sh'

log "rsyncing backend/ → /root/putcafe/api/"
ssh_ 'mkdir -p /root/putcafe/api'
rsync_ -az --delete --exclude node_modules --exclude dist --exclude __pycache__ \
  "$repo/backend/" "$CONN_USER@$CONN_IP:/root/putcafe/api/"

log "building + starting the stack (docker compose up -d --build)"
ssh_ 'cd /root/putcafe/api && docker compose up -d --build --remove-orphans'

host="putcafe.$EDGE_HOST"
log "health checks (public, via Caddy)"
for i in $(seq 1 15); do
  ok=1
  for p in /api/positions/health /api/bot/health; do
    curl -sf --max-time 5 "https://$host$p" >/dev/null || ok=0
  done
  [ "$ok" -eq 1 ] && break
  [ "$i" -eq 15 ] && { echo "health check failed" >&2; exit 1; }
  sleep 2
done
for p in /api/positions/health /api/bot/health; do
  printf '%-22s %s\n' "$p" "$(curl -s --max-time 5 "https://$host$p")"
done
log "API live at https://$host/api/"
