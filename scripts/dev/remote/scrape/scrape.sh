#!/usr/bin/env bash
# RUNS ON THE VPS (scp'd to /root/putcafe/scrape.sh by the laptop wrappers).
# Controls the candle-scrape job (pc-candle-store) in the api compose stack.
#
#   scrape.sh <start|stop|resume|status|monitor|export <args...>>
#
# The scraper resumes from its SQLite watermarks, so start == resume and both
# are safe to re-run anytime. stop is graceful (SIGTERM -> manifest written).
set -euo pipefail

API_DIR=/root/putcafe/api
cd "$API_DIR" 2>/dev/null || { echo "no api stack at $API_DIR — deploy backend first" >&2; exit 1; }
[ -d scrape ] || { echo "scrape/ not deployed — push backend via CI (or deploy-api.sh) first" >&2; exit 1; }

dc() { docker compose --profile scrape "$@"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  start|resume)
    dc up -d --build scrape
    echo "scrape job running (state below); follow with: monitor"
    dc ps scrape
    ;;
  stop)
    dc stop -t 30 scrape
    echo "stopped; manifest written under /data/manifests/"
    ;;
  status)
    echo "== container =="
    dc ps scrape || true
    echo "== status.json =="
    if docker compose exec -T bot test -f /data/status.json 2>/dev/null; then
      docker compose exec -T bot cat /data/status.json | python3 -m json.tool 2>/dev/null \
        || docker compose exec -T bot cat /data/status.json
    else
      echo "(no run yet — no /data/status.json)"
    fi
    echo "== disk =="
    docker compose exec -T bot du -sh /data 2>/dev/null || echo "(volume not readable yet)"
    echo "== manifests =="
    docker compose exec -T bot ls -1 /data/manifests 2>/dev/null || echo "(none)"
    ;;
  monitor)
    # Self-refreshing dashboard (fetched vs estimated-total per exchange), not
    # a log tail. Runs a throwaway container that reads the shared volume.
    dc run --rm --no-deps -T scrape python -m scraper.render --watch
    ;;
  logs)
    dc logs -f --tail 50 scrape
    ;;
  export)
    dc run --rm --no-deps scrape python -m scraper.export "$@"
    ;;
  *)
    echo "usage: scrape.sh <start|stop|resume|status|monitor|logs|export <exchange> <market> <resolution> [start end]>" >&2
    exit 2
    ;;
esac
