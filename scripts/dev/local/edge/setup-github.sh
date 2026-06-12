#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Wires GitHub Actions to the VPS edge (run once after `setup.sh`
# and after the GitHub remote exists):
#   * secret  VPS_SSH_KEY            — the putcafe_ci private key
#   * vars    VPS_HOST/VPS_USER/VPS_PORT
#   * gated `production` environment — required reviewer = you (the authenticated user)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
log() { printf '\033[1;35m[putcafe-gh]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[putcafe-gh] %s\033[0m\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die "gh CLI not installed"
gh auth status >/dev/null 2>&1 || die "gh not authenticated (gh auth login)"

KEY="$here/.secrets/putcafe_ci"
ENV="$here/.secrets/vps.env"
[ -f "$KEY" ] || die "missing $KEY — run ./scripts/dev/local/edge/setup.sh first"
[ -f "$ENV" ] || die "missing $ENV — run ./scripts/dev/local/edge/setup.sh first"
# shellcheck disable=SC1090
source "$ENV"
: "${VPS_HOST:?VPS_HOST missing in $ENV}"

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" \
  || die "no GitHub repo here — add the remote first (git remote add origin …)"
log "repo: $REPO"

log "setting secret VPS_SSH_KEY + vars VPS_HOST/VPS_USER/VPS_PORT"
gh secret set VPS_SSH_KEY < "$KEY"
gh variable set VPS_HOST --body "$VPS_HOST"
gh variable set VPS_USER --body "${VPS_USER:-root}"
gh variable set VPS_PORT --body "${VPS_PORT:-22}"

log "creating gated 'production' environment (required reviewer: you)"
ME="$(gh api user --jq .id)"
gh api -X PUT "repos/$REPO/environments/production" \
  --input - <<EOF >/dev/null
{ "reviewers": [ { "type": "User", "id": $ME } ] }
EOF

log "done. push main → staging deploy; tag v* → gated prod deploy."
