#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Adds/refreshes the putcafe site on the shared VPS edge: uploads
# the putcafe edge assets, runs the idempotent remote setup, and (first run) saves the
# CI deploy key + connection facts to .secrets/ for ops.sh / deploy.sh / setup-github.sh.
#
# Requires the Orion edge to already be provisioned on the box (shared Caddy) — the
# remote setup fails loudly otherwise. Safe to re-run anytime.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"                  # scripts/dev/local/edge
remote_dir="$(cd "$here/../../remote/edge" && pwd)"    # scripts/dev/remote/edge (assets)
log() { printf '\033[1;35m[putcafe-setup]\033[0m %s\n' "$*"; }

# shellcheck source=_conn.sh
source "$here/_conn.sh"
log "target: $CONN_USER@$CONN_IP:$CONN_PORT (auth: $([ "$FIRST_RUN" -eq 1 ] && echo password || echo key))"

log "creating /root/putcafe on the VPS"
ssh_ 'mkdir -p /root/putcafe/site/web'

log "uploading putcafe edge assets"
scp_ "$remote_dir/site.caddy" "$remote_dir/setup.sh" "$remote_dir/ops.sh" \
     "$CONN_USER@$CONN_IP:/root/putcafe/"

log "running remote setup (idempotent)…"
ssh_ 'bash /root/putcafe/setup.sh'

if [ "$FIRST_RUN" -eq 1 ]; then
  log "fetching CI private key → $KEY_FILE"
  ssh_ 'cat /root/.ssh/putcafe_ci' > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  cat > "$ENV_FILE" <<EOF
VPS_HOST=$CONN_IP
VPS_USER=$CONN_USER
VPS_PORT=$CONN_PORT
EOF
  log "saved $ENV_FILE"
fi

log "next: ./scripts/dev/local/edge/deploy.sh staging   (first content)"
log "      ./scripts/dev/local/edge/setup-github.sh     (CI wiring, needs the GitHub remote)"
