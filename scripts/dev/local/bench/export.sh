#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Export a spec's results to Parquet on the VPS, then copy it
# back to ./out/.
#   ./scripts/dev/local/bench/export.sh <spec>
#   e.g. ./scripts/dev/local/bench/export.sh pivot-map
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: export.sh <spec>" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/_run.sh"
spec="$1"
bench_remote export "$spec"
name="${spec}.parquet"
mkdir -p "$here/out"
ssh_ "docker compose -f /root/putcafe/api/compose.yml exec -T bot cat /data/bench/exports/$name" \
  > "$here/out/$name"
echo "copied to scripts/dev/local/bench/out/$name"
