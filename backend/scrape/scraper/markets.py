"""Market selection per exchange: active spot pairs with base∈BASES and
quote∈QUOTES, ranked by 30d quote volume (sum of close×volume over the last
30 daily candles — no ticker API), top N kept."""

import asyncio

from . import config

RANK_DAYS = 30


def candidates(exchange) -> list[str]:
    out = []
    for sym, m in exchange.markets.items():
        if not m.get("spot") or m.get("active") is False:
            continue
        if m.get("base") in config.BASES and m.get("quote") in config.QUOTES:
            out.append(sym)
    return sorted(set(out))


async def quote_volume_30d(exchange, symbol: str) -> float:
    try:
        daily = await exchange.fetch_ohlcv(symbol, "1d", limit=RANK_DAYS)
    except Exception:
        return 0.0
    return sum(c[4] * c[5] for c in daily if c[4] and c[5])


async def select(exchange) -> list[str]:
    syms = candidates(exchange)
    vols = await asyncio.gather(*(quote_volume_30d(exchange, s) for s in syms))
    ranked = sorted(zip(syms, vols), key=lambda x: -x[1])
    return [s for s, v in ranked[: config.TOP_N] if v > 0]
