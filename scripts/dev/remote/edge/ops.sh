#!/usr/bin/env bash
# Runs ON the VPS (as root). Putcafe edge operations.
#
#   bash /root/putcafe/ops.sh <status|start|stop|restart|reload|logs|health>
#
# NOTE: the edge (Orion's `edge` compose stack — containerized Caddy) is SHARED with
# Orion — start/stop/restart affect Orion too. Prefer `reload` (no dropped
# connections) for config changes.
set -euo pipefail

EDGE_COMPOSE=/root/orion/edge/compose.yml
edge() { docker compose -f "$EDGE_COMPOSE" "$@"; }
cmd="${1:-}"

host() { sed -n 's/^ORION_HOST=//p' /root/orion/orion-web.env 2>/dev/null; }

case "$cmd" in
  status)
    echo "edge-caddy (shared edge): $(docker ps --filter name=edge-caddy --format '{{.Status}}' 2>/dev/null | grep . || echo 'NOT RUNNING')"
    echo "edge host: $(host || echo '?')"
    echo "import wired: $( (grep -qxF 'import /root/*/site.caddy' /root/orion/Caddyfile || grep -qxF 'import /root/putcafe/site.caddy' /root/orion/Caddyfile) 2>/dev/null && echo yes || echo NO)"
    echo "site tree:"
    find /root/putcafe/site -maxdepth 3 -name index.html 2>/dev/null | sed 's/^/  /' || true
    echo "ops-ui (dozzle): $(docker ps --filter name=ops-ui-dozzle --format '{{.Status}}' 2>/dev/null | grep . || echo 'not running')"
    ;;
  start|stop|restart)
    echo "WARNING: the edge is shared with Orion — '$cmd' affects Orion too." >&2
    case "$cmd" in
      start)   edge up -d ;;
      stop)    edge stop ;;
      restart) edge restart ;;
    esac
    ;;
  reload)
    edge exec -T caddy caddy reload --config /root/orion/Caddyfile --adapter caddyfile --force
    ;;
  logs)
    edge logs -f caddy
    ;;
  health)
    h="$(host)"
    [ -n "$h" ] || { echo "no edge host configured" >&2; exit 1; }
    for p in /web/ /web/staging/; do
      printf '%-15s ' "$p"
      curl -sI --max-time 10 "https://putcafe.$h$p" | head -n1 || echo "FAILED"
    done
    printf '%-15s ' "ops UI"
    curl -sLo /dev/null -w 'HTTP %{http_code} (login page)\n' --max-time 10 \
      "https://ops.$h/" || echo "FAILED"
    ;;
  *)
    echo "usage: ops.sh <status|start|stop|restart|reload|logs|health>" >&2
    exit 2
    ;;
esac
