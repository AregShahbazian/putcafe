#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Stop the VPS candle-scrape job (pc-candle-store).
#   ./scripts/dev/local/scrape/stop.sh
set -euo pipefail
source "$(dirname "$0")/_run.sh"
scrape_remote stop
