#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Self-refreshing scrape dashboard — fetched vs estimated
# candles per exchange, fits the terminal, repaints every few seconds. Ctrl-C to
# exit (the job keeps running). For raw container logs use: scrape.sh logs.
#   ./scripts/dev/local/scrape/monitor.sh
set -euo pipefail
source "$(dirname "$0")/_run.sh"
SCRAPE_TTY=1 scrape_remote monitor
