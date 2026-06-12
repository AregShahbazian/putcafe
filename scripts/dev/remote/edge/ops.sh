#!/usr/bin/env bash
# Runs ON the VPS (as root). Putcafe edge operations.
#
#   bash /root/putcafe/ops.sh <status|start|stop|restart|reload|logs|health>
#
# NOTE: the edge service (orion-web) is SHARED with Orion — start/stop/restart affect
# Orion too. Prefer `reload` (no dropped connections) for config changes.
set -euo pipefail

cmd="${1:-}"

host() { sed -n 's/^ORION_HOST=//p' /root/orion/orion-web.env 2>/dev/null; }

case "$cmd" in
  status)
    echo "orion-web (shared edge): $(systemctl is-active orion-web 2>/dev/null || echo unknown)"
    echo "caddy: $(command -v caddy >/dev/null 2>&1 && caddy version | head -n1 || echo 'NOT INSTALLED')"
    echo "edge host: $(host || echo '?')"
    echo "import wired: $( (grep -qxF 'import /root/*/site.caddy' /root/orion/Caddyfile || grep -qxF 'import /root/putcafe/site.caddy' /root/orion/Caddyfile) 2>/dev/null && echo yes || echo NO)"
    echo "site tree:"
    find /root/putcafe/site -maxdepth 3 -name index.html 2>/dev/null | sed 's/^/  /' || true
    echo "ops-ui (dozzle): $(docker ps --filter name=ops-ui-dozzle --format '{{.Status}}' 2>/dev/null | grep . || echo 'not running')"
    ;;
  start|stop|restart)
    echo "WARNING: orion-web is shared with Orion — '$cmd' affects Orion too." >&2
    systemctl "$cmd" orion-web
    ;;
  reload)
    systemctl reload orion-web || systemctl restart orion-web
    ;;
  logs)
    journalctl -u orion-web -f
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
