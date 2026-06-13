#!/usr/bin/env bash
# Runs ON the VPS (as root). Idempotent — every step checks first, then acts; safe to
# re-run against the live box anytime.
#
# Provisions the cross-app "home" portal host (home.<ORION_HOST>) on the EXISTING shared
# Orion edge (one containerized Caddy, Orion's `edge` compose stack). The shared
# Caddyfile already does `import /root/*/site.caddy`, so dropping /root/home/site.caddy
# is enough to wire the host in — no Caddyfile edit. The one real change to the Orion
# edge is a read-only mount of /root/home into the caddy container (so file_server can
# read the page); that needs the container recreated, which this does once.
#
# Expects the home assets already copied to /root/home/ (site.caddy, setup.sh,
# gen-home-index.sh) by the laptop orchestrator. Orion + putcafe are otherwise untouched.
set -euo pipefail
log() { printf '\033[1;36m[home-vps]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[home-vps] %s\033[0m\n' "$*" >&2; exit 1; }

HOME_DIR=/root/home
ORION_CADDYFILE=/root/orion/Caddyfile
ORION_ENV=/root/orion/orion-web.env
EDGE_COMPOSE=/root/orion/edge/compose.yml
MOUNT='- /root/home:/root/home:ro'
ANCHOR='- /root/putcafe:/root/putcafe:ro'   # insert the home mount right after this one

# --- Preconditions: the Orion edge must exist (home never provisions Caddy) ------------
command -v docker >/dev/null 2>&1 || die "docker not installed — provision the Orion edge first"
[ -f "$ORION_CADDYFILE" ] || die "$ORION_CADDYFILE missing — provision the Orion edge first"
[ -f "$EDGE_COMPOSE" ] || die "$EDGE_COMPOSE missing — provision the Orion edge first"

ORION_HOST=""
[ -f "$ORION_ENV" ] && ORION_HOST="$(sed -n 's/^ORION_HOST=//p' "$ORION_ENV")"
[ -n "$ORION_HOST" ] || die "$ORION_ENV missing/empty — run the Orion edge setup first"
log "edge host: $ORION_HOST → site: home.$ORION_HOST"

# --- Layout + page --------------------------------------------------------------------
log "laying out $HOME_DIR/site"
mkdir -p "$HOME_DIR/site"
chmod +x "$HOME_DIR/setup.sh" "$HOME_DIR/gen-home-index.sh" 2>/dev/null || true
log "generating the portal page"
bash "$HOME_DIR/gen-home-index.sh" "$ORION_HOST" "$HOME_DIR/site"

# --- Mount /root/home into the edge caddy container (idempotent) -----------------------
MOUNT_ADDED=0
if grep -qF -- "$MOUNT" "$EDGE_COMPOSE"; then
  log "edge already mounts /root/home"
else
  grep -qF -- "$ANCHOR" "$EDGE_COMPOSE" || die "anchor mount not found in $EDGE_COMPOSE — refusing to guess placement"
  log "adding /root/home read-only mount to the edge compose"
  cp "$EDGE_COMPOSE" "$EDGE_COMPOSE.pre-home"
  # Append the home mount line right after the putcafe one, matching its indentation.
  indent="$(grep -F -- "$ANCHOR" "$EDGE_COMPOSE" | sed -E 's/[^ ].*$//' | head -1)"
  sed -i "\\|$ANCHOR|a\\${indent}${MOUNT}" "$EDGE_COMPOSE"
  grep -qF -- "$MOUNT" "$EDGE_COMPOSE" || { mv "$EDGE_COMPOSE.pre-home" "$EDGE_COMPOSE"; die "failed to insert mount — reverted"; }
  MOUNT_ADDED=1
fi

# --- Validate the merged Caddyfile (mount every imported site dir) ---------------------
log "validating the merged Caddyfile"
if ! docker run --rm -e "ORION_HOST=$ORION_HOST" \
       -v /root/orion:/root/orion:ro -v /root/putcafe:/root/putcafe:ro -v /root/home:/root/home:ro \
       caddy:2.11 caddy validate --config "$ORION_CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
  [ "$MOUNT_ADDED" -eq 1 ] && mv "$EDGE_COMPOSE.pre-home" "$EDGE_COMPOSE"
  die "merged Caddyfile failed validation — reverted, Orion edge unchanged"
fi
rm -f "$EDGE_COMPOSE.pre-home"

# --- Apply ----------------------------------------------------------------------------
# A new mount only takes effect on container (re)create; a plain reload can't see it.
# So: first run (mount added) → recreate via `up -d`; thereafter → hot reload.
if [ "$MOUNT_ADDED" -eq 1 ] || ! docker ps --filter name=edge-caddy --format '{{.Names}}' | grep -q .; then
  log "recreating the edge stack to apply the new mount"
  docker compose -f "$EDGE_COMPOSE" up -d
else
  log "reloading the edge caddy"
  docker compose -f "$EDGE_COMPOSE" exec -T caddy \
    caddy reload --config "$ORION_CADDYFILE" --adapter caddyfile --force
fi

# --- Report ---------------------------------------------------------------------------
log "edge status: $(docker ps --filter name=edge-caddy --format '{{.Status}}' | grep . || echo 'NOT RUNNING')"
log "done. https://home.$ORION_HOST/   | web root: $HOME_DIR/site"
log "(first cert issuance for the new subdomain takes a few seconds)"
