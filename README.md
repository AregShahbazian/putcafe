# putcafe

Crypto trading-bot simulation and backtesting app. Pick a Binance market and a
historical range, choose an algorithm, run it as a headless backtest or as a
candle-by-candle **replay** on a live chart, and inspect every order, fill and
position the strategy produced — all of it scriptable from the browser console.

## Why

Most backtesters hand you a P&L number and a chart. This one was built to make
the *mechanics* honest and inspectable:

- **Fill honesty.** A hedge-mode, isolated-margin futures engine matches resting
  orders against each candle's OHLC along a deterministic intra-candle path
  (green `O→L→H→C`, red `O→H→L→C`). An order fills only when the range actually
  crosses its price — no lookahead; conflicting crossings in one candle resolve
  pessimistically for the strategy. Fees, slippage and liquidation are modelled.
- **Algos never touch the arithmetic.** Strategies drive the engine through an
  order protocol (`place / cancel / amend`, `open_position / close_position`),
  so every algo — DCA, pivot (swing high/low breakout), MA cross, RSI revert,
  Bollinger, Donchian, MACD — runs on exactly the same matching rules.
- **Replay what actually happened.** The bot computes the whole session as a
  snapshot once; the frontend reveals it by cursor, so replay is deterministic
  and the chart (markers, SL/TP lines, pivot triangles) shows what the engine
  really did, never a re-simulation.
- **Everything is scriptable.** A console bridge (`window.pc`) exposes sessions,
  playback, chart state and a frontend↔backend consistency check, so the same
  API drives manual exploration, Playwright E2E tests and ad-hoc analysis.

## Architecture

Monorepo with three services plus a Postgres database:

```
frontend/            React 18 + TypeScript + Vite, lightweight-charts
  src/backtest/      session engine: fetch klines, call the bot, replay by cursor
  src/chart/         chart view, pivot markers, range highlight
  src/debug/         `window.pc` console bridge
  e2e/               Playwright specs driving the bridge

backend/bot/         Python 3.12 + FastAPI  (:8102)  — stateless backtests
  app/futures.py     hedge-mode isolated-margin matching engine
  app/algos/         dca, pivot, ma_cross, rsi_revert, bollinger, donchian, macd
  app/pivots.py      swing high/low detection (no lookahead, optional alternation)
  tuner.py           parameter-grid tuner; writes tuned_defaults.json

backend/positions/   Node 22 + Fastify + Postgres  (:8101) — session store
  src/index.ts       /api/positions/sessions CRUD (config + engine snapshot)

backend/compose.yml  db (postgres:17) + positions + bot, bound to 127.0.0.1
```

Data flow: the frontend fetches klines straight from Binance's public API,
posts them with the chosen algo/params to `POST /api/bot/futures/run`, receives
the full snapshot (positions, order ledger, trades, events, equity) and persists
config + snapshot via the positions service so sessions survive reloads and show
up in the overview. In production one Caddy reverse-proxies `/api/positions/*`
and `/api/bot/*` to the two containers and serves the built frontend.

## Run locally

### Full stack (Docker Compose)

```bash
./scripts/dev/local/run-stack.sh        # db + positions + bot, then the frontend dev server
# http://localhost:5180
./scripts/dev/local/run-stack.sh down   # stop the backends
./scripts/dev/local/run-stack.sh logs   # follow backend logs
```

Requires Docker with the compose plugin, Node 22 and Yarn. The frontend runs
with `VITE_LOCAL_STACK=1` so Vite proxies `/api/*` to the local containers.
After editing Python in `backend/bot/app`, run `./scripts/dev/local/rebuild-bot.sh`
(the bot image copies the code at build time).

### Per service

```bash
# positions (needs DATABASE_URL, default postgres://putcafe:putcafe@db:5432/putcafe)
cd backend/positions && yarn && yarn build && yarn start

# bot
cd backend/bot && python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8102

# frontend
cd frontend && yarn && yarn dev      # http://localhost:5173
```

The frontend reads `VITE_API_BASE` (see `frontend/.env.example`) for the API
origin; `VITE_LOCAL_BOT=1` routes only `/api/bot/*` to a locally run bot while
positions stay on the configured API — handy for testing bot changes pre-merge.

### Tune algo parameters

```bash
cd backend/bot && .venv/bin/python tuner.py [--quick]
```

Fetches real klines for several symbols, sweeps a parameter grid per indicator
algo across non-overlapping windows, ranks by consistency and writes
`tuned_defaults.json`.

## Console bridge (`window.pc`)

Everything the UI can do — and everything worth inspecting — is scriptable
from the browser console, or from Playwright via `page.evaluate`. Every
command returns a Promise of plain JSON; `pc.help()` lists them all.

```js
await pc.ready                                          // app + chart mounted
await pc.session.start({ algo: "pivot", mode: "replay", start, end })
await pc.playTo(entryTime)              // play, pause exactly on that candle
await pc.chart.markers()                // what's actually drawn (render-settled)
await pc.verify()                       // frontend↔backend diff / sim invariants
pc.events.since(0)                      // structured event log (trades, status…)
```

- **Sessions** — `pc.session.start/stop/loadPreset/loadSession`; overrides
  default from the UI and the visible UI stays in sync.
- **Playback** — `pc.play/pause/stepForward/stepBack/restart/setSpeed/
  setAutoResume`, `pc.playTo(time)`, awaitable `pc.waitFor.status/time/
  finished/trade` with structured timeouts.
- **Inspection** — `pc.state.*` (snapshot, candles, trades, pivots, sim,
  config) and `pc.chart.*` (markers, pivot triangles, SL/TP price lines,
  visible range — what is *actually rendered*, never a stale frame).
- **Cross-check** — `pc.backend.sessions/session` passthrough; `pc.verify()`
  diffs frontend state against the positions backend (or checks pivot-sim
  invariants).
- The classic dump still works: `pc()` / `pc(candleTime)`.

Source: `frontend/src/debug/bridge.ts`.

## Tests

```bash
cd frontend
yarn e2e        # Playwright specs driving the bridge, dev server on :5183
```

- `frontend/e2e/bridge.spec.ts` — the living example: headless run → verify →
  replay → playTo → chart assertions.
- `frontend/e2e/algos.spec.ts` — runs every indicator algo on a fixed range and
  checks the engine's sim invariants via `pc.verify()`.

Both are network-dependent (Binance klines + a reachable bot/positions API —
either `VITE_API_BASE` or the local stack). They use system Chrome
(`channel: "chrome"`) and their own port so they never reuse another
worktree's dev server. There are no unit tests yet; correctness is enforced
through the engine's invariant checks exercised end-to-end.

## Deployment

`.github/workflows/ci.yml` is path-filtered: pushes to `main` deploy the
frontend to a staging slot and, when `backend/**` changed, rebuild the API
stack; `feature/**` and `dev/**` branches get their own preview slot; a `v*`
tag deploys prod behind a GitHub `production` environment gate. Targets are a
single VPS with a shared Caddy edge, reached via `VPS_HOST/VPS_USER/VPS_PORT`
variables and a `VPS_SSH_KEY` secret.

`scripts/dev/local/edge/` holds the laptop-side provisioning and deploy
scripts (`setup.sh`, `deploy.sh`, `deploy-api.sh`, `ops.sh`,
`setup-github.sh`); `scripts/dev/remote/edge/` the counterparts that run on
the box. Connection details live in gitignored `deploy.conf` / `.secrets/`
(see `deploy.conf.example`); the public host defaults to `sslip.io` over the
VPS IP and can be overridden with `EDGE_HOST`. The edge assumes a pre-existing
shared Caddy stack from a sibling project, so treat these as reference rather
than a turnkey installer.

## Status

Personal project, actively used for strategy exploration; not production
trading software and not connected to any exchange account — it only reads
public kline data. Futures-only (the earlier spot mode was removed). Known
gaps: no unit tests, no auth on the API (sessions are shared by everyone who
can reach it), E2E tests depend on live Binance data, and `tuned_defaults.json`
reflects a small tuning run rather than a rigorous study.

## License

MIT — see [LICENSE](LICENSE).
