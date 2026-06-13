#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Resume the VPS candle-scrape job (pc-candle-store).
#   ./scripts/dev/local/scrape/resume.sh
set -euo pipefail
source "$(dirname "$0")/_run.sh"
scrape_remote resume
