#!/usr/bin/env bash
# RUNS ON THE VPS (scp'd to /root/putcafe/bench.sh by the laptop wrappers).
# Controls the benchmark-runner job (pc-benchmark-runner) in the api compose
# stack. Replays algos over the stored candle corpus and writes results +
# leaderboards under /data/bench/.
#
#   bench.sh <start <spec>|stop|resume <spec>|status|monitor|leaderboard <spec> [metric]|export <spec>>
#
# The runner skips already-stored sessions, so start == resume and both are safe
# to re-run. stop is graceful (SIGTERM -> manifest written).
set -euo pipefail

API_DIR=/root/putcafe/api
cd "$API_DIR" 2>/dev/null || { echo "no api stack at $API_DIR — deploy backend first" >&2; exit 1; }
[ -d bench ] || { echo "bench/ not deployed — push backend via CI (or deploy-api.sh) first" >&2; exit 1; }

dc() { docker compose --profile bench "$@"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  start|resume)
    spec="${1:-algo-compare}"
    echo "running spec: $spec"
    BENCH_SPEC="$spec" dc up -d --build bench
    echo "bench job running; follow with: monitor"
    dc ps bench
    ;;
  stop)
    dc stop -t 30 bench
    echo "stopped; manifest written under /data/bench/manifests/"
    ;;
  status)
    echo "== container =="
    dc ps bench || true
    echo "== status.json =="
    if docker compose exec -T bot test -f /data/bench/status.json 2>/dev/null; then
      docker compose exec -T bot cat /data/bench/status.json | python3 -m json.tool 2>/dev/null \
        || docker compose exec -T bot cat /data/bench/status.json
    else
      echo "(no run yet — no /data/bench/status.json)"
    fi
    echo "== disk =="
    docker compose exec -T bot du -sh /data/bench 2>/dev/null || echo "(no bench data yet)"
    echo "== manifests =="
    docker compose exec -T bot ls -1 /data/bench/manifests 2>/dev/null || echo "(none)"
    ;;
  monitor)
    dc logs -f --tail 50 bench
    ;;
  leaderboard)
    [ $# -ge 1 ] || { echo "usage: bench.sh leaderboard <spec> [metric]" >&2; exit 2; }
    spec="$1"; metric="${2:-return_pct}"
    dc run --rm --no-deps -T bench python -m bench.leaderboard "$spec" --metric "$metric"
    ;;
  export)
    [ $# -ge 1 ] || { echo "usage: bench.sh export <spec>" >&2; exit 2; }
    dc run --rm --no-deps -T bench python -m bench.export "$1"
    ;;
  *)
    echo "usage: bench.sh <start <spec>|stop|resume <spec>|status|monitor|leaderboard <spec> [metric]|export <spec>>" >&2
    exit 2
    ;;
esac
