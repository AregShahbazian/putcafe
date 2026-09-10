#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Provisions the cross-app "home" portal host (home.<ORION_HOST>) on
# the shared VPS edge: uploads the home assets, runs the idempotent remote setup, and
# fetches the rendered page back to ./portal/index.html (gitignored) — the exact file to
# drop on the web root of any other static host you own (it links to the same live URLs).
#
# Requires the Orion edge to already be provisioned on the box (shared Caddy). Safe to
# re-run anytime.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"                       # scripts/dev/local/edge
assets="$(cd "$here/../../remote/edge/home" && pwd)"        # scripts/dev/remote/edge/home
log() { printf '\033[1;36m[home-setup]\033[0m %s\n' "$*"; }

# shellcheck source=_conn.sh
source "$here/_conn.sh"
log "target: $CONN_USER@$CONN_IP:$CONN_PORT (auth: $([ "$FIRST_RUN" -eq 1 ] && echo password || echo key))"

log "creating /root/home on the VPS"
ssh_ 'mkdir -p /root/home/site'

log "uploading home edge assets"
scp_ "$assets/site.caddy" "$assets/setup.sh" "$assets/gen-home-index.sh" \
     "$CONN_USER@$CONN_IP:/root/home/"

log "running remote setup (idempotent)…"
ssh_ 'bash /root/home/setup.sh'

log "fetching the rendered portal → $here/portal/index.html"
mkdir -p "$here/portal"
scp_ "$CONN_USER@$CONN_IP:/root/home/site/index.html" "$here/portal/index.html"

host="$(ssh_ "sed -n 's/^ORION_HOST=//p' /root/orion/orion-web.env")"
log "done."
log "  VPS portal : https://home.$host/"
log "  static host: upload $here/portal/index.html to your own web root (optional)"
