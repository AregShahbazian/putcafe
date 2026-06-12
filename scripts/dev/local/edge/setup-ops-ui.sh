#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Provisions the VPS ops UI (Dozzle) — one URL to see every
# container on the box (logs, stats, start/stop/restart) behind a login:
#
#   https://ops.<host>/        creds in .secrets/ops-ui.env (generated first run)
#
# Re-runs the site edge setup first (idempotent — wires/validates/reloads Caddy
# with the ops host block), then provisions the dozzle stack. Safe to re-run.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"                  # scripts/dev/local/edge
remote_dir="$(cd "$here/../../remote/edge" && pwd)"    # scripts/dev/remote/edge (assets)
log() { printf '\033[1;35m[putcafe-ops-ui]\033[0m %s\n' "$*"; }

# shellcheck source=_conn.sh
source "$here/_conn.sh"
log "target: $CONN_USER@$CONN_IP:$CONN_PORT (auth: $([ "$FIRST_RUN" -eq 1 ] && echo password || echo key))"

# --- Credentials: generate once, keep in gitignored .secrets/ -------------------------
CREDS_FILE="$here/.secrets/ops-ui.env"
if [ ! -f "$CREDS_FILE" ]; then
  log "generating ops UI credentials → $CREDS_FILE"
  printf 'OPS_UI_USER=%s\nOPS_UI_PASSWORD=%s\n' \
    "areg" "$(openssl rand -hex 16)" > "$CREDS_FILE"
  chmod 600 "$CREDS_FILE"
fi

# --- Edge first: site.caddy now carries the ops host block ----------------------------
log "refreshing the putcafe edge (site.caddy incl. ops host)…"
"$here/setup.sh"

# --- Upload the ops-ui assets ----------------------------------------------------------
log "uploading ops-ui assets"
ssh_ 'mkdir -p /root/putcafe/ops-ui'
# -p preserves mtimes: the remote setup regenerates users.yml only when creds.env
# is newer than it, so a stable creds mtime makes re-runs true no-ops.
scp_ -p "$remote_dir/ops-ui/compose.yml" "$remote_dir/setup-ops-ui.sh" "$CREDS_FILE" \
     "$CONN_USER@$CONN_IP:/root/putcafe/ops-ui/"
ssh_ 'mv -f /root/putcafe/ops-ui/ops-ui.env /root/putcafe/ops-ui/creds.env && chmod 600 /root/putcafe/ops-ui/creds.env'

log "running remote ops-ui setup (idempotent)…"
ssh_ 'bash /root/putcafe/ops-ui/setup-ops-ui.sh'

host="ops.${CONN_IP//./-}.sslip.io"
log "waiting for https://$host/ …"
for i in $(seq 1 15); do
  # -L: / 307-redirects to the login page; 200 after following = healthy
  code="$(curl -sLo /dev/null -w '%{http_code}' --max-time 10 "https://$host/" || true)"
  [ "$code" = "200" ] && break
  [ "$i" -eq 15 ] && { echo "ops UI not reachable (last http $code)" >&2; exit 1; }
  sleep 2
done
log "ops UI live: https://$host/  (login: see $CREDS_FILE)"
