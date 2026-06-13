#!/usr/bin/env bash
# Sourced by the laptop bench wrappers — pushes the remote multiplexer to the
# VPS (idempotent) and runs one of its commands. Connection via ../edge/_conn.sh.
set -euo pipefail
_bench_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_remote="$(cd "$_bench_here/../../remote/bench" && pwd)"

# shellcheck source=../edge/_conn.sh
source "$_bench_here/../edge/_conn.sh"

bench_remote() {
  scp_ -q "$_remote/bench.sh" "$CONN_USER@$CONN_IP:/root/putcafe/bench.sh"
  if [ "${BENCH_TTY:-0}" = 1 ]; then
    ssh_ -t "bash /root/putcafe/bench.sh $(printf '%q ' "$@")"
  else
    ssh_ "bash /root/putcafe/bench.sh $(printf '%q ' "$@")"
  fi
}
