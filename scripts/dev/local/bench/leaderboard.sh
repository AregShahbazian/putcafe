#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Build + print the leaderboard for a spec on the VPS, then
# copy the .md report back to ./out/.
#   ./scripts/dev/local/bench/leaderboard.sh <spec> [metric]
#   e.g. ./scripts/dev/local/bench/leaderboard.sh pivot-map return_pct
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: leaderboard.sh <spec> [metric]" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/_run.sh"
spec="$1"; metric="${2:-return_pct}"
bench_remote leaderboard "$spec" "$metric"
name="${spec}-${metric}.md"
mkdir -p "$here/out"
ssh_ "docker compose -f /root/putcafe/api/compose.yml exec -T bot cat /data/bench/leaderboards/$name" \
  > "$here/out/$name"
echo "copied to scripts/dev/local/bench/out/$name"
