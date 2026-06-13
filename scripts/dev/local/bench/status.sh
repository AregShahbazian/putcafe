#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Status of the VPS benchmark-runner job.
#   ./scripts/dev/local/bench/status.sh
set -euo pipefail
source "$(dirname "$0")/_run.sh"
bench_remote status
