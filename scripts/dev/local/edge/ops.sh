#!/usr/bin/env bash
# RUN ON YOUR LAPTOP. Routine putcafe edge operations without logging into the VPS —
# a thin SSH wrapper around scripts/dev/remote/edge/ops.sh on the box.
#
#   ./scripts/dev/local/edge/ops.sh <status|start|stop|restart|reload|logs|health>
#
# Works before first setup too (password fallback via deploy.conf — see _conn.sh).
# `health` curls the PUBLIC https://putcafe.<host>/ end-to-end from the laptop.
# NOTE: start/stop/restart act on the SHARED edge service (orion-web) — affects Orion.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

cmd="${1:-}"
case "$cmd" in status|start|stop|restart|reload|logs|health) ;; *)
  echo "usage: ops.sh <status|start|stop|restart|reload|logs|health>" >&2; exit 2 ;;
esac

# shellcheck source=_conn.sh
source "$here/_conn.sh"

if [ "$cmd" = "health" ]; then
  host="putcafe.${CONN_IP//./-}.sslip.io"
  echo "curling https://$host (public, end-to-end)"
  for p in /web/ /web/staging/; do
    printf '%-15s ' "$p"
    curl -sI --max-time 10 "https://$host$p" | head -n1 || echo "FAILED"
  done
  printf '%-15s ' "ops UI"
  curl -sLo /dev/null -w 'HTTP %{http_code} (login page)\n' --max-time 10 \
    "https://ops.${CONN_IP//./-}.sslip.io/" || echo "FAILED"
  exit 0
fi

ssh_ "bash /root/putcafe/ops.sh $cmd"
