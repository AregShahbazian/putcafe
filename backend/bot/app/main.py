"""Bot-backend: stateless futures backtest. One call runs an algo over a candle
range on the hedge-mode isolated-margin engine (`futures.py` + `algos/`) and
returns the full snapshot — positions, the order ledger, trades, events, equity.
The frontend persists the snapshot to the positions-backend and reveals it by
cursor in replay. No per-candle round-trips, no in-memory sessions; spot is gone."""

import os
import sqlite3

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import algos, pivots

CANDLE_DATA_DIR = os.environ.get("CANDLE_DATA_DIR", "/data")
BENCH_DB = os.path.join(CANDLE_DATA_DIR, "bench", "results.db")

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class Candle(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class PivotOptions(BaseModel):
    enabled: bool = False
    lookback: int = Field(default=3, ge=1)
    alternation: bool = True


class FuturesParams(BaseModel):
    # Shared knobs (defaults cover both algos; an algo ignores what it doesn't use).
    quoteAmount: float = Field(default=100.0, gt=0)  # isolated margin per position
    leverage: int = Field(default=1, ge=1, le=125)
    tpSlRatio: float = Field(default=2.0, ge=0)
    slCapPct: float = Field(default=4.0, gt=0)  # SL distance from entry (%)
    frequencySec: int = Field(default=7 * 24 * 3600, gt=0)  # DCA cadence
    feesEnabled: bool = True
    startingBalance: float = 1000.0
    # Indicator-algo knobs (fast/slow/period/oversold/…); ignored by dca/pivot.
    algoParams: dict = Field(default_factory=dict)


class RunBody(BaseModel):
    candles: list[Candle]
    algo: str
    pivots: PivotOptions
    params: FuturesParams


class AnalyzeBody(BaseModel):
    candles: list[Candle]
    pivots: PivotOptions


@app.get("/api/bot/health")
def health():
    return {"ok": True}


@app.post("/api/bot/futures/run")
def futures_run(body: RunBody):
    """Run `algo` over the candle range and return the futures snapshot."""
    if body.algo not in algos.ALGOS:
        raise HTTPException(status_code=400, detail=f"unknown algo: {body.algo}")
    candles = [c.model_dump() for c in body.candles]
    return algos.run(body.algo, candles, body.params, body.pivots)


@app.get("/api/bot/candles")
def candles(exchange: str, market: str, resolution: str, start: int, end: int):
    """Stored candles from the scrape corpus (pc-candle-store). start/end are
    epoch-seconds (end exclusive); shards keep epoch-ms. Missing shard or empty
    range is a hard 404 — callers must never silently fall back to live data."""
    shard = os.path.join(CANDLE_DATA_DIR, f"{exchange}.db")
    if not os.path.exists(shard):
        raise HTTPException(status_code=404, detail=f"not in store: no shard for {exchange}")
    conn = sqlite3.connect(f"file:{shard}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT ts, open, high, low, close, volume FROM candles"
            " WHERE market=? AND resolution=? AND ts>=? AND ts<? ORDER BY ts",
            (market, resolution, start * 1000, end * 1000),
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"not in store: {exchange} {market} {resolution} [{start},{end})")
    return {"candles": [
        {"time": ts // 1000, "open": o, "high": h, "low": lo, "close": c, "volume": v}
        for ts, o, h, lo, c, v in rows
    ]}


@app.post("/api/bot/analyze")
def analyze(body: AnalyzeBody):
    """Stateless pivot analysis — the live-chart indicator overlay and loaded
    finished sessions (whose snapshot already holds its own pivots)."""
    candles = [c.model_dump() for c in body.candles]
    if not body.pivots.enabled:
        return {"pivots": None}
    return {"pivots": pivots.detect(candles, body.pivots.lookback, body.pivots.alternation)}


# --- Benchmark results (pc-benchmark-runner) — read-only over results.db -------
# The bench worker writes /data/bench/results.db; the bot mounts /data ro and
# serves it to the benchmark UI. Same ro-sqlite pattern as /api/bot/candles.

def _bench_conn():
    if not os.path.exists(BENCH_DB):
        raise HTTPException(status_code=404, detail="no benchmark data yet")
    return sqlite3.connect(f"file:{BENCH_DB}?mode=ro", uri=True)


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    if not n:
        return 0.0
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2


@app.get("/api/bot/bench/algos")
def bench_algos():
    """One summary row per algo (config_hash): session count + return / win /
    drawdown aggregates. Powers the top-level leaderboard."""
    conn = _bench_conn()
    try:
        rows = conn.execute(
            "SELECT config_hash, algo, return_pct, win_rate, max_drawdown, bust"
            " FROM results").fetchall()
    finally:
        conn.close()
    by: dict = {}
    for ch, algo, ret, win, dd, bust in rows:
        g = by.setdefault((ch, algo), {"ret": [], "win": [], "dd": [], "bust": 0})
        g["ret"].append(ret or 0.0)
        g["win"].append(win or 0.0)
        g["dd"].append(dd or 0.0)
        g["bust"] += int(bust or 0)
    out = [
        {"config_hash": ch, "algo": algo, "sessions": len(g["ret"]),
         "avg_return_pct": sum(g["ret"]) / len(g["ret"]),
         "median_return_pct": _median(g["ret"]),
         "best_return_pct": max(g["ret"]), "worst_return_pct": min(g["ret"]),
         "avg_win_rate": sum(g["win"]) / len(g["win"]),
         "avg_max_drawdown": sum(g["dd"]) / len(g["dd"]),
         "busts": g["bust"]}
        for (ch, algo), g in by.items()
    ]
    out.sort(key=lambda r: r["median_return_pct"], reverse=True)
    return {"algos": out}


@app.get("/api/bot/bench/markets")
def bench_markets(config_hash: str):
    """Per-(exchange,market,resolution) aggregates for one algo — drill-down."""
    conn = _bench_conn()
    try:
        rows = conn.execute(
            "SELECT exchange, market, resolution, COUNT(*), AVG(return_pct),"
            " AVG(win_rate), AVG(max_drawdown) FROM results WHERE config_hash=?"
            " GROUP BY exchange, market, resolution ORDER BY AVG(return_pct) DESC",
            (config_hash,)).fetchall()
    finally:
        conn.close()
    return {"markets": [
        {"exchange": ex, "market": m, "resolution": r, "sessions": n,
         "avg_return_pct": ar, "avg_win_rate": wr, "avg_max_drawdown": dd}
        for ex, m, r, n, ar, wr, dd in rows
    ]}


@app.get("/api/bot/bench/sessions")
def bench_sessions(config_hash: str, exchange: str | None = None,
                   market: str | None = None, resolution: str | None = None):
    """Raw per-window session rows (the distribution + table view)."""
    q = ("SELECT exchange, market, resolution, range_start, range_end,"
         " return_pct, win_rate, max_drawdown, trades, bust"
         " FROM results WHERE config_hash=?")
    params: list = [config_hash]
    for col, val in (("exchange", exchange), ("market", market),
                     ("resolution", resolution)):
        if val:
            q += f" AND {col}=?"
            params.append(val)
    q += " ORDER BY range_start"
    conn = _bench_conn()
    try:
        rows = conn.execute(q, params).fetchall()
    finally:
        conn.close()
    return {"sessions": [
        {"exchange": ex, "market": m, "resolution": r,
         "range_start": rs, "range_end": re_, "return_pct": ret,
         "win_rate": win, "max_drawdown": dd, "trades": tr, "bust": bool(bust)}
        for ex, m, r, rs, re_, ret, win, dd, tr, bust in rows
    ]}
