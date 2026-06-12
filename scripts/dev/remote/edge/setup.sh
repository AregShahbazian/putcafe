#!/usr/bin/env bash
# Runs ON the VPS (as root). Idempotent — every step checks first, then acts; safe to
# re-run against the live box anytime.
#
# Adds the putcafe site to the EXISTING Orion edge (one shared Caddy, orion-web.service):
# lays out /root/putcafe, ensures one `import` line in /root/orion/Caddyfile (validated,
# reverted on failure), reloads the edge, and generates the putcafe CI deploy key.
# Orion is required and otherwise untouched.
#
# Expects the putcafe assets already copied to /root/putcafe/ (putcafe.caddy, ops.sh,
# setup.sh) by the laptop orchestrator.
set -euo pipefail
log() { printf '\033[1;35m[putcafe-vps]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[putcafe-vps] %s\033[0m\n' "$*" >&2; exit 1; }

PUTCAFE=/root/putcafe
ORION_CADDYFILE=/root/orion/Caddyfile
ORION_ENV=/root/orion/orion-web.env
IMPORT_LINE="import $PUTCAFE/site.caddy"
# Orion's phase-12 Caddyfile template imports sibling sites generically; when that
# line is present, no putcafe-specific line is needed.
GLOB_IMPORT='import /root/*/site.caddy'
OLD_IMPORT="import $PUTCAFE/putcafe.caddy"

# --- Preconditions: the Orion edge must exist (putcafe never provisions Caddy) --------
command -v caddy >/dev/null 2>&1 || die "caddy not installed — provision the Orion edge first"
[ -f "$ORION_CADDYFILE" ] || die "$ORION_CADDYFILE missing — provision the Orion edge first"
systemctl list-unit-files orion-web.service >/dev/null 2>&1 \
  && systemctl is-enabled orion-web >/dev/null 2>&1 \
  || die "orion-web.service missing/disabled — provision the Orion edge first"

# ORION_HOST for validation + reporting (the running unit gets it from its EnvironmentFile).
ORION_HOST=""
[ -f "$ORION_ENV" ] && ORION_HOST="$(sed -n 's/^ORION_HOST=//p' "$ORION_ENV")"
[ -n "$ORION_HOST" ] || die "$ORION_ENV missing/empty — run the Orion edge setup first"
log "edge host: $ORION_HOST → site: putcafe.$ORION_HOST"

# --- Layout ---------------------------------------------------------------------------
log "laying out $PUTCAFE/site/web"
mkdir -p "$PUTCAFE/site/web"
chmod +x "$PUTCAFE/ops.sh" "$PUTCAFE/setup.sh" 2>/dev/null || true

# --- Migrate the legacy putcafe.caddy wiring (renamed to site.caddy) -------------------
if grep -qxF "$OLD_IMPORT" "$ORION_CADDYFILE"; then
  log "migrating legacy import line (putcafe.caddy → site.caddy)"
  sed -i "\\|^$OLD_IMPORT\$|d; \\|^# putcafe site (added by|d" "$ORION_CADDYFILE"
fi
rm -f "$PUTCAFE/putcafe.caddy"

# --- Wire the site into the shared Caddyfile (append once, validate, revert on fail) ---
if grep -qxF "$GLOB_IMPORT" "$ORION_CADDYFILE" || grep -qxF "$IMPORT_LINE" "$ORION_CADDYFILE"; then
  log "site import already wired in $ORION_CADDYFILE"
else
  log "appending import line to $ORION_CADDYFILE"
  cp "$ORION_CADDYFILE" "$ORION_CADDYFILE.pre-putcafe"
  printf '\n# putcafe site (added by %s/setup.sh)\n%s\n' "$PUTCAFE" "$IMPORT_LINE" >> "$ORION_CADDYFILE"
  if ! ORION_HOST="$ORION_HOST" caddy validate --config "$ORION_CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    mv "$ORION_CADDYFILE.pre-putcafe" "$ORION_CADDYFILE"
    die "merged Caddyfile failed validation — reverted, Orion edge unchanged"
  fi
  rm -f "$ORION_CADDYFILE.pre-putcafe"
fi

# --- Apply: reload keeps connections; restart only if the edge isn't running ----------
if systemctl is-active --quiet orion-web; then
  log "reloading orion-web"
  systemctl reload orion-web || systemctl restart orion-web
else
  log "orion-web not running — starting it"
  systemctl restart orion-web
fi

# --- CI / ops deploy key (separate from Orion's) ---------------------------------------
KEY=/root/.ssh/putcafe_ci
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ ! -f "$KEY" ]; then
  log "generating CI deploy key"
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "putcafe-ci" >/dev/null
fi
PUB="$(cat "$KEY.pub")"
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
grep -qF "$PUB" /root/.ssh/authorized_keys || echo "$PUB" >> /root/.ssh/authorized_keys

# --- Report ---------------------------------------------------------------------------
log "orion-web status: $(systemctl is-active orion-web)"
log "done. https://putcafe.$ORION_HOST/web/  | web root: $PUTCAFE/site  | CI key: $KEY"
log "(first cert issuance for the new subdomain takes a few seconds)"
