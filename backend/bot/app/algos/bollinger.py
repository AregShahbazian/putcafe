"""Bollinger-band breakout. Long when price closes above the upper band, short
below the lower; carries the side until the opposite band breaks (momentum)."""

from .. import indicators as ind
from . import signal_base


def signal(candles, params):
    cfg = signal_base.algo_params(params, period=20, mult=2.0)
    closes = ind.closes(candles)
    _, upper, lower = ind.bollinger(closes, int(cfg["period"]), float(cfg["mult"]))
    out = []
    state = 0
    for i, c in enumerate(closes):
        if upper[i] is not None:
            if c >= upper[i]:
                state = 1
            elif c <= lower[i]:
                state = -1
        out.append(state)
    return out


def run(engine, candles, params, pivot_options):
    return signal_base.drive(engine, candles, params, signal)
