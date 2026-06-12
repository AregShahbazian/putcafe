#!/usr/bin/env bash
# Runs ON the VPS (as root). Idempotent — provisions the ops UI (Dozzle) at
# /root/putcafe/ops-ui: generates users.yml from creds.env (only on change),
# starts the compose stack, restarts dozzle only when the creds changed.
# Never touches the api stack, Orion, or Caddy.
#
# Expects compose.yml + creds.env (OPS_UI_USER/OPS_UI_PASSWORD, 0600) already
# copied to /root/putcafe/ops-ui/ by the laptop orchestrator.
set -euo pipefail
log() { printf '\033[1;35m[putcafe-ops-ui]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[putcafe-ops-ui] %s\033[0m\n' "$*" >&2; exit 1; }

OPS_UI=/root/putcafe/ops-ui
IMAGE=amir20/dozzle:v8

command -v docker >/dev/null 2>&1 || die "docker not installed — run deploy-api.sh first"
[ -f "$OPS_UI/compose.yml" ] || die "$OPS_UI/compose.yml missing — run the laptop setup-ops-ui.sh"
[ -f "$OPS_UI/creds.env" ] || die "$OPS_UI/creds.env missing — run the laptop setup-ops-ui.sh"

# shellcheck source=/dev/null
source "$OPS_UI/creds.env"
[ -n "${OPS_UI_USER:-}" ] && [ -n "${OPS_UI_PASSWORD:-}" ] \
  || die "OPS_UI_USER/OPS_UI_PASSWORD missing in $OPS_UI/creds.env"

mkdir -p "$OPS_UI/data"

# --- users.yml: generate with the matching dozzle version, only when creds changed ---
# (bcrypt output differs per run, so compare by mtime, not content)
creds_changed=0
if [ ! -f "$OPS_UI/data/users.yml" ] || [ "$OPS_UI/creds.env" -nt "$OPS_UI/data/users.yml" ]; then
  log "generating users.yml (bcrypt, via dozzle generate)"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  docker run --rm "$IMAGE" generate "$OPS_UI_USER" \
    --password="$OPS_UI_PASSWORD" --name="$OPS_UI_USER" > "$tmp" \
    || die "dozzle generate failed"
  [ -s "$tmp" ] || die "dozzle generate produced empty output"
  install -m 600 "$tmp" "$OPS_UI/data/users.yml"
  creds_changed=1
  log "users.yml installed"
else
  log "users.yml up to date"
fi

# --- Stack up (pulls the image on first run; no build step) ---------------------------
log "starting the ops-ui stack (docker compose up -d)"
(cd "$OPS_UI" && docker compose up -d)

if [ "$creds_changed" -eq 1 ]; then
  log "credentials changed — restarting dozzle"
  (cd "$OPS_UI" && docker compose restart dozzle)
fi

ORION_HOST="$(sed -n 's/^ORION_HOST=//p' /root/orion/orion-web.env 2>/dev/null || true)"
log "done. https://ops.${ORION_HOST:-<host>}/  (login: $OPS_UI_USER)"
