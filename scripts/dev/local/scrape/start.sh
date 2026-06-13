#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Start the VPS candle-scrape job (pc-candle-store).
#   ./scripts/dev/local/scrape/start.sh
set -euo pipefail
source "$(dirname "$0")/_run.sh"
scrape_remote start
