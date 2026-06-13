"""Algos drive the futures engine through the order protocol. Each exposes
`run(engine, candles, params, pivot_options) -> pivots|None`."""

from ..futures import FuturesEngine
from . import bollinger, dca, donchian, ma_cross, macd, pivot, rsi_revert

ALGOS = {
    "dca": dca,
    "pivot": pivot,
    "ma_cross": ma_cross,
    "rsi_revert": rsi_revert,
    "bollinger": bollinger,
    "donchian": donchian,
    "macd": macd,
}


def run(algo: str, candles: list[dict], params, pivot_options) -> dict:
    """Run an algo over a candle range on a fresh engine; return the snapshot."""
    impl = ALGOS.get(algo)
    if impl is None:
        raise ValueError(f"unknown algo: {algo}")
    leverage = int(getattr(params, "leverage", 1))
    engine = FuturesEngine(
        starting_balance=float(params.startingBalance),
        fees=bool(params.feesEnabled),
    )
    detected = impl.run(engine, candles, params, pivot_options)
    return engine.snapshot(leverage=leverage, pivots=detected)
