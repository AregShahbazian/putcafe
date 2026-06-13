#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Stop the VPS benchmark-runner job (graceful — manifest
# written; stored results intact).
#   ./scripts/dev/local/bench/stop.sh
set -euo pipefail
source "$(dirname "$0")/_run.sh"
bench_remote stop
