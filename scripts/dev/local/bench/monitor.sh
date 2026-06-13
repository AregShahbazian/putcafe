#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Follow the VPS benchmark-runner logs until interrupted.
#   ./scripts/dev/local/bench/monitor.sh
set -euo pipefail
source "$(dirname "$0")/_run.sh"
BENCH_TTY=1 bench_remote monitor
