"""Bot-backend: stateless futures backtest. One call runs an algo over a candle
range on the hedge-mode isolated-margin engine (`futures.py` + `algos/`) and
returns the full snapshot — positions, the order ledger, trades, events, equity.
The frontend persists the snapshot to the positions-backend and reveals it by
cursor in replay. No per-candle round-trips, no in-memory sessions; spot is gone."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import algos, pivots

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


@app.post("/api/bot/analyze")
def analyze(body: AnalyzeBody):
    """Stateless pivot analysis — the live-chart indicator overlay and loaded
    finished sessions (whose snapshot already holds its own pivots)."""
    candles = [c.model_dump() for c in body.candles]
    if not body.pivots.enabled:
        return {"pivots": None}
    return {"pivots": pivots.detect(candles, body.pivots.lookback, body.pivots.alternation)}
