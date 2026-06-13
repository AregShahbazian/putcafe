# putcafe

Crypto trading bot simulation and backtesting app. Monorepo — `frontend/` for
the web app, `backend/` for the positions + bot services.

## Run (dev)

```bash
cd frontend
yarn
yarn dev        # http://localhost:5173
```

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

### E2E

```bash
cd frontend
yarn e2e        # Playwright spec driving the bridge, dev server on :5183
```

`frontend/e2e/bridge.spec.ts` is the living example: headless run → verify →
replay → playTo → chart assertions. Network-dependent (Binance klines + the
backend in `VITE_API_BASE`). Uses system Chrome (`channel: "chrome"`) and its
own port, so it never reuses another worktree's dev server.

## Candle store (benchmark corpus)

`backend/scrape/` scrapes historical OHLCV from 18 exchanges (ccxt, public
endpoints) into per-exchange SQLite shards on the VPS `candledata` volume —
the fixed, reproducible corpus that benchmark runs replay against. Scope is
config (`scraper/config.py`): top-20 majors per exchange, last 2 years,
1m/1h/1d. Each run writes a JSON+md manifest under `/data/manifests/`.

Operate it from the laptop (thin SSH wrappers; the scraper resumes from its
shard watermarks, so everything is safe to re-run):

```bash
./scripts/dev/local/scrape/start.sh     # kick off / resume (detached)
./scripts/dev/local/scrape/status.sh    # container + progress + disk + manifests
./scripts/dev/local/scrape/monitor.sh   # follow logs (Ctrl-C detaches, job keeps going)
./scripts/dev/local/scrape/stop.sh      # graceful stop (writes manifest)
./scripts/dev/local/scrape/export.sh binance BTC/USDT 1h 2025-01-01 2025-06-01
                                        # Parquet slice → ./scripts/dev/local/scrape/exports/
```

Stored candles are served by the bot:
`GET /api/bot/candles?exchange&market&resolution&start&end` (epoch-seconds,
end exclusive) — 404 `not in store` when missing, never a live fallback.
