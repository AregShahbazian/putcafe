#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Print an overview of the candle corpus we have — per
# exchange & resolution: markets, candle counts, date spans. Pass --log to also
# append a timestamped snapshot to /data/overviews/ on the VPS.
#   ./scripts/dev/local/scrape/overview.sh [--log]
set -euo pipefail
source "$(dirname "$0")/_run.sh"
scrape_remote overview "$@"
