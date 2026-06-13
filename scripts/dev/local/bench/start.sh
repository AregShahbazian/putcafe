#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Start the VPS benchmark-runner job (pc-benchmark-runner).
#   ./scripts/dev/local/bench/start.sh [spec]   (default: algo-compare)
set -euo pipefail
source "$(dirname "$0")/_run.sh"
bench_remote start "${1:-algo-compare}"
