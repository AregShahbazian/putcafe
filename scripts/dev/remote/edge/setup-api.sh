#!/usr/bin/env bash
# Runs ON the VPS (as root). Idempotent — installs Docker Engine + the compose
# plugin if absent (get.docker.com convenience script); never touches anything else.
set -euo pipefail
log() { printf '\033[1;35m[putcafe-api]\033[0m %s\n' "$*"; }

if command -v docker >/dev/null 2>&1; then
  log "docker already installed ($(docker --version))"
else
  log "installing docker (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
fi

docker compose version >/dev/null 2>&1 || {
  log "installing docker compose plugin"
  apt-get update && apt-get install -y docker-compose-plugin
}

systemctl is-active --quiet docker || systemctl start docker
systemctl is-enabled --quiet docker || systemctl enable docker
log "docker ready: $(docker compose version --short 2>/dev/null || echo '?')"
