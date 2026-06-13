"""MA crossover (golden/death cross), trend-following. Long while the fast MA is
above the slow MA, short below — always-in / stop-and-reverse."""

from .. import indicators as ind
from . import signal_base


def signal(candles, params):
    cfg = signal_base.algo_params(params, fast=20, slow=50, maType="ema")
    closes = ind.closes(candles)
    fn = ind.ema if cfg["maType"] == "ema" else ind.sma
    f = fn(closes, int(cfg["fast"]))
    s = fn(closes, int(cfg["slow"]))
    return [0 if a is None or b is None else (1 if a > b else -1 if a < b else 0) for a, b in zip(f, s)]


def run(engine, candles, params, pivot_options):
    return signal_base.drive(engine, candles, params, signal)
