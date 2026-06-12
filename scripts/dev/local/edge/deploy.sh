#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Manual deploy of the frontend to the putcafe edge — same targets
# as ci.yml, for first content and pipeline-less testing.
#
#   ./scripts/dev/local/edge/deploy.sh             # -> /web/staging/  (default)
#   ./scripts/dev/local/edge/deploy.sh <slot>      # -> /web/<slot>/
#   ./scripts/dev/local/edge/deploy.sh prod        # -> /web/          (no --delete)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
frontend="$(cd "$here/../../../../frontend" && pwd)"
log() { printf '\033[1;35m[putcafe-deploy]\033[0m %s\n' "$*"; }

slot="${1:-staging}"

# shellcheck source=_conn.sh
source "$here/_conn.sh"

log "building frontend (yarn build)"
(cd "$frontend" && yarn --frozen-lockfile --silent && yarn --silent build)

if [ "$slot" = "prod" ]; then
  # Prod is the /web/ root — NEVER --delete (it would wipe the sibling slot dirs).
  dest=/root/putcafe/site/web
  log "deploying → /web/ (prod, no --delete)"
  ssh_ "mkdir -p $dest"
  rsync_ -az "$frontend/dist/" "$CONN_USER@$CONN_IP:$dest/"
else
  dest="/root/putcafe/site/web/$slot"
  log "deploying → /web/$slot/ (mirror)"
  ssh_ "mkdir -p $dest"
  rsync_ -az --delete "$frontend/dist/" "$CONN_USER@$CONN_IP:$dest/"
fi

host="putcafe.${CONN_IP//./-}.sslip.io"
[ "$slot" = "prod" ] && url="https://$host/web/" || url="https://$host/web/$slot/"
log "done → $url"
