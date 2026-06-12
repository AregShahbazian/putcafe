#!/usr/bin/env bash
# Rebuild & restart the bot service so Python changes in backend/bot/app take
# effect. The bot image COPYs app/ at build time (no volume / no --reload), so a
# plain restart is NOT enough — the image must be rebuilt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT/backend"

echo "==> Rebuilding bot image and restarting service..."
docker compose up -d --build bot

echo "==> Done. Recent bot logs:"
docker compose logs --tail 20 bot
