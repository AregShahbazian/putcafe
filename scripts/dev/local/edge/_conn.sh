#!/usr/bin/env bash
# Sourced by the laptop edge scripts — resolves the VPS connection and defines
# ssh_/scp_/rsync_ helpers. Key-first, safe before first setup:
#   * .secrets/putcafe_ci + .secrets/vps.env exist -> key auth (no password)
#   * otherwise -> sshpass + deploy.conf (SERVER_IP/SERVER_USER/SERVER_PASSWORD[/PORT])
# The public edge host defaults to sslip.io over the VPS IP (<a-b-c-d>.sslip.io);
# set EDGE_HOST (env, deploy.conf or vps.env) to use a real domain instead.
# Sets: CONN_IP CONN_USER CONN_PORT EDGE_HOST FIRST_RUN KEY_FILE ENV_FILE
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { printf '\033[1;31m[putcafe-edge] %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$_here/.secrets"; chmod 700 "$_here/.secrets"
KEY_FILE="$_here/.secrets/putcafe_ci"
ENV_FILE="$_here/.secrets/vps.env"

_COMMON=(-o StrictHostKeyChecking=accept-new)

FIRST_RUN=1
if [ -f "$KEY_FILE" ] && [ -f "$ENV_FILE" ]; then
  FIRST_RUN=0
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  CONN_IP="${VPS_HOST:?VPS_HOST missing in $ENV_FILE}"
  CONN_USER="${VPS_USER:-root}"
  CONN_PORT="${VPS_PORT:-22}"
  ssh_()   { ssh -i "$KEY_FILE" "${_COMMON[@]}" -p "$CONN_PORT" "$CONN_USER@$CONN_IP" "$@"; }
  scp_()   { scp -i "$KEY_FILE" "${_COMMON[@]}" -P "$CONN_PORT" "$@"; }
  rsync_() { rsync -e "ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new -p $CONN_PORT" "$@"; }
else
  command -v sshpass >/dev/null || die "sshpass not installed (apt install sshpass)"
  DEPLOY_CONF="${DEPLOY_CONF:-$_here/deploy.conf}"
  [ -f "$DEPLOY_CONF" ] || die "no key yet and creds file not found: $DEPLOY_CONF (copy deploy.conf.example)"
  # shellcheck disable=SC1090
  source "$DEPLOY_CONF"
  : "${SERVER_IP:?SERVER_IP missing in $DEPLOY_CONF}"
  : "${SERVER_PASSWORD:?SERVER_PASSWORD missing in $DEPLOY_CONF}"
  CONN_IP="$SERVER_IP"
  CONN_USER="${SERVER_USER:-root}"
  CONN_PORT="${SERVER_SSH_PORT:-22}"
  ssh_()   { sshpass -p "$SERVER_PASSWORD" ssh "${_COMMON[@]}" -p "$CONN_PORT" "$CONN_USER@$CONN_IP" "$@"; }
  scp_()   { sshpass -p "$SERVER_PASSWORD" scp "${_COMMON[@]}" -P "$CONN_PORT" "$@"; }
  rsync_() { sshpass -p "$SERVER_PASSWORD" rsync -e "ssh -o StrictHostKeyChecking=accept-new -p $CONN_PORT" "$@"; }
fi

# Public host the shared edge serves: putcafe.<EDGE_HOST>, ops.<EDGE_HOST>, …
EDGE_HOST="${EDGE_HOST:-${CONN_IP//./-}.sslip.io}"
