#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Export a stored slice to Parquet on the VPS, then copy it
# back to ./exports/ here.
#   ./scripts/dev/local/scrape/export.sh <exchange> <market> <resolution> [start end]
#   e.g. ./scripts/dev/local/scrape/export.sh binance BTC/USDT 1h 2025-01-01 2025-06-01
set -euo pipefail
[ $# -ge 3 ] || { echo "usage: export.sh <exchange> <market> <resolution> [start end]" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/_run.sh"
scrape_remote export "$@"
name="${1}_${2//\//-}_${3}.parquet"
mkdir -p "$here/exports"
ssh_ "docker compose -f /root/putcafe/api/compose.yml exec -T bot cat /data/exports/$name" \
  > "$here/exports/$name"
echo "copied to scripts/dev/local/scrape/exports/$name"
