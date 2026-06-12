#!/usr/bin/env bash
# Run the FULL API stack locally (one command) so the frontend can be tested
# without deploying to the VPS. Brings up all three services from
# backend/compose.yml — db (postgres) + positions (the "api") + bot — builds
# the current worktree's code, waits for both health endpoints, and prints them.
#
#   ./scripts/dev/local/run-stack.sh            # up + build + health
#   ./scripts/dev/local/run-stack.sh down       # stop + remove
#   ./scripts/dev/local/run-stack.sh logs        # follow logs
#
# Ports (bound to 127.0.0.1): positions :8101, bot :8102.
# The Vite dev server proxies /api/positions/* and /api/bot/* to these, so the
# frontend needs no VITE_API_BASE (same-origin) — just `yarn dev`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT/backend"

case "${1:-up}" in
  down) docker compose down --remove-orphans; exit 0 ;;
  logs) docker compose logs -f; exit 0 ;;
esac

echo "==> building + starting db + positions + bot…"
docker compose up -d --build --remove-orphans

echo "==> waiting for health…"
for hp in "8101:/api/positions/health" "8102:/api/bot/health"; do
  port="${hp%%:*}"; path="${hp#*:}"
  for i in $(seq 1 30); do
    curl -sf --max-time 3 "http://127.0.0.1:${port}${path}" >/dev/null 2>&1 && break
    [ "$i" -eq 30 ] && { echo "  ${path} did NOT come up — check: ./scripts/dev/local/run-stack.sh logs" >&2; exit 1; }
    sleep 1
  done
  printf '   %-26s %s\n' "$path" "$(curl -s --max-time 3 "http://127.0.0.1:${port}${path}")"
done
echo "==> stack up. Frontend: cd frontend && yarn dev  (proxies /api to these)."
