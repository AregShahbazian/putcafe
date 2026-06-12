"""RSI mean-reversion. Buy when RSI is oversold, fade when overbought, flat in
the neutral band (so the engine flattens between extremes)."""

from .. import indicators as ind
from . import signal_base


def signal(candles, params):
    cfg = signal_base.algo_params(params, period=14, oversold=30, overbought=70)
    r = ind.rsi(ind.closes(candles), int(cfg["period"]))
    os_, ob = float(cfg["oversold"]), float(cfg["overbought"])
    out = []
    for v in r:
        if v is None:
            out.append(0)
        elif v <= os_:
            out.append(1)
        elif v >= ob:
            out.append(-1)
        else:
            out.append(0)
    return out


def run(engine, candles, params, pivot_options):
    return signal_base.drive(engine, candles, params, signal)
