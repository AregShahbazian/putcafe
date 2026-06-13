#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Follow live scrape logs (Ctrl-C to detach; job keeps running).
#   ./scripts/dev/local/scrape/monitor.sh
set -euo pipefail
source "$(dirname "$0")/_run.sh"
scrape_remote monitor
