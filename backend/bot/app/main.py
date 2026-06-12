"""Bot-backend: per-candle trading decisions. Support data (seeded candle history +
algo config) is held in memory per session — the durable truth lives in the
positions-backend; on a restart the frontend re-seeds (409 not_seeded)."""

import os

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import dca, pivot_strategy, pivots

POSITIONS_URL = os.environ.get("POSITIONS_URL", "http://positions:8101")

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# session_id -> {"algo": str, "config": dict, "candles": list[dict], "pivots": dict}
sessions: dict[str, dict] = {}


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


class SeedBody(BaseModel):
    algo: str
    config: dict
    candles: list[Candle]
    options: PivotOptions | None = None


class StepBody(BaseModel):
    candle: Candle


class RunBody(BaseModel):
    candles: list[Candle]


class OptionsBody(BaseModel):
    pivots: PivotOptions


class AnalyzeBody(BaseModel):
    candles: list[Candle]
    pivots: PivotOptions


class StrategyParams(BaseModel):
    tpSlRatio: float = Field(default=2.0, ge=0)
    slCapPct: float = Field(default=4.0, gt=0)
    quoteAmount: float = Field(default=100.0, gt=0)
    leverage: int = Field(default=1, ge=1, le=125)
    feesEnabled: bool = True
    startingBalance: float = 1000.0


class SimulateBody(BaseModel):
    candles: list[Candle]
    pivots: PivotOptions
    params: StrategyParams


def session_pivots(s: dict) -> list[dict] | None:
    opts = s["pivots"]
    if not opts.enabled:
        return None
    return pivots.detect(s["candles"], opts.lookback, opts.alternation)


@app.get("/api/bot/health")
def health():
    return {"ok": True, "sessions": len(sessions)}


@app.post("/api/bot/sessions/{session_id}/seed")
def seed(session_id: str, body: SeedBody):
    if body.algo != "dca":
        raise HTTPException(status_code=400, detail="unknown algo")
    s = {
        "algo": body.algo,
        "config": body.config,
        "candles": [c.model_dump() for c in body.candles],
        "pivots": body.options or PivotOptions(),
    }
    sessions[session_id] = s
    return {"ok": True, "historySize": len(body.candles), "pivots": session_pivots(s)}


@app.post("/api/bot/sessions/{session_id}/step")
async def step(session_id: str, body: StepBody):
    s = sessions.get(session_id)
    if s is None:
        raise HTTPException(status_code=409, detail="not_seeded")
    candle = body.candle.model_dump()
    s["candles"].append(candle)

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{POSITIONS_URL}/api/positions/sessions/{session_id}/state")
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="positions state unavailable")
    state = r.json()

    decisions = dca.decide(s["config"], candle, state.get("lastTradeTime"))
    return {"decisions": decisions, "pivots": session_pivots(s)}


@app.post("/api/bot/sessions/{session_id}/run")
async def run(session_id: str, body: RunBody):
    """Headless batch: run the whole backtest range server-side in one call.

    The per-candle decision loop stays in Python; `last_trade_time` is tracked
    locally (no per-candle positions GET) and positions is only hit on actual
    fills, over the in-cluster network. Collapses the frontend's thousands of
    public round-trips into one."""
    s = sessions.get(session_id)
    if s is None:
        raise HTTPException(status_code=409, detail="not_seeded")

    async with httpx.AsyncClient(timeout=30, base_url=POSITIONS_URL) as client:
        r = await client.get(f"/api/positions/sessions/{session_id}/state")
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="positions state unavailable")
        last_trade_time = r.json().get("lastTradeTime")

        trades = 0
        for c in body.candles:
            candle = c.model_dump()
            s["candles"].append(candle)
            for d in dca.decide(s["config"], candle, last_trade_time):
                order = await client.post(
                    f"/api/positions/sessions/{session_id}/orders",
                    json={
                        "time": candle["time"],
                        "side": d["side"],
                        "quoteAmount": d["quoteAmount"],
                        "price": candle["close"],
                    },
                )
                # Only a successful fill advances the DCA clock; an insufficient-
                # balance 409 leaves last_trade_time so it retries next candle.
                if order.status_code == 200 and order.json().get("filled"):
                    last_trade_time = candle["time"]
                    trades += 1

    return {"steps": len(body.candles), "trades": trades, "pivots": session_pivots(s)}


@app.put("/api/bot/sessions/{session_id}/options")
def set_options(session_id: str, body: OptionsBody):
    """Replay live-control: swap pivot options mid-session, recompute over
    the candles seen so far."""
    s = sessions.get(session_id)
    if s is None:
        raise HTTPException(status_code=409, detail="not_seeded")
    s["pivots"] = body.pivots
    return {"ok": True, "pivots": session_pivots(s)}


@app.post("/api/bot/analyze")
def analyze(body: AnalyzeBody):
    """Stateless pivot analysis — for loaded finished sessions, whose bot-side
    in-memory session is long gone."""
    candles = [c.model_dump() for c in body.candles]
    if not body.pivots.enabled:
        return {"pivots": None}
    return {"pivots": pivots.detect(candles, body.pivots.lookback, body.pivots.alternation)}


@app.post("/api/bot/simulate")
def simulate(body: SimulateBody):
    """Stateless pivot-breakout backtest over a candle range — returns trades +
    brackets + equity. The frontend renders it and replay reveals by cursor; no
    positions-backend involvement (spot/buy-only can't model this)."""
    candles = [c.model_dump() for c in body.candles]
    return pivot_strategy.simulate(candles, body.pivots, body.params)


@app.delete("/api/bot/sessions/{session_id}")
def forget(session_id: str):
    sessions.pop(session_id, None)
    return {"ok": True}
