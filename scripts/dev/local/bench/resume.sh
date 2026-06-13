#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Resume the VPS benchmark-runner job — re-runs a spec,
# skipping already-stored sessions (idempotent).
#   ./scripts/dev/local/bench/resume.sh [algo]   (default: donchian)
set -euo pipefail
source "$(dirname "$0")/_run.sh"
bench_remote resume "${1:-donchian}"
