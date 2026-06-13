#!/usr/bin/env bash
# Sourced by the laptop scrape wrappers — pushes the remote multiplexer to the
# VPS (idempotent) and runs one of its commands. Connection via ../edge/_conn.sh.
set -euo pipefail
_scrape_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_remote="$(cd "$_scrape_here/../../remote/scrape" && pwd)"

# shellcheck source=../edge/_conn.sh
source "$_scrape_here/../edge/_conn.sh"

scrape_remote() {
  scp_ -q "$_remote/scrape.sh" "$CONN_USER@$CONN_IP:/root/putcafe/scrape.sh"
  if [ "${SCRAPE_TTY:-0}" = 1 ]; then
    ssh_ -t "bash /root/putcafe/scrape.sh $(printf '%q ' "$@")"
  else
    ssh_ "bash /root/putcafe/scrape.sh $(printf '%q ' "$@")"
  fi
}
