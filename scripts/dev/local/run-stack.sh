#!/usr/bin/env bash
# Run the FULL local environment in one command — no VPS deploy needed.
# Brings up all three backend services from backend/compose.yml — db (postgres)
# + positions (the "api") + bot — builds the current worktree's code, health-
# checks them, THEN starts the frontend dev server wired to them.
#
#   ./scripts/dev/local/run-stack.sh            # backends up + frontend dev (foreground)
#   ./scripts/dev/local/run-stack.sh up         # backends only (no frontend)
#   ./scripts/dev/local/run-stack.sh down       # stop + remove the backends
#   ./scripts/dev/local/run-stack.sh logs       # follow backend logs
#
# Ports (bound to 127.0.0.1): positions :8101, bot :8102. The dev server runs
# with VITE_LOCAL_STACK=1 so Vite proxies /api/positions/* and /api/bot/* to the
# local containers (same-origin, no VITE_API_BASE). Ctrl-C stops the frontend;
# the backends stay up — run with `down` to stop them.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT/backend"

mode="${1:-dev}"   # default: backends + frontend; `up` = backends only
case "$mode" in
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
echo "==> backends up."

if [ "$mode" = "up" ]; then
  echo "   (backends only — run without args to also start the frontend)"
  exit 0
fi

cd "$ROOT/frontend"
[ -d node_modules ] || { echo "==> installing frontend deps…"; yarn install; }
echo "==> starting frontend (VITE_LOCAL_STACK) — Ctrl-C stops it; backends stay up ('down' to stop them)."
exec env VITE_LOCAL_STACK=1 yarn dev
