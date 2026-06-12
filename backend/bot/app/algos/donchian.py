"""Donchian-channel breakout, trend-following (turtle-style). Long on a break
above the prior-N-candle high, short below the low; carries the side."""

from .. import indicators as ind
from . import signal_base


def signal(candles, params):
    cfg = signal_base.algo_params(params, period=20)
    upper, lower = ind.donchian(candles, int(cfg["period"]))
    out = []
    state = 0
    for i, c in enumerate(candles):
        if upper[i] is not None:
            if c["high"] >= upper[i]:
                state = 1
            elif c["low"] <= lower[i]:
                state = -1
        out.append(state)
    return out


def run(engine, candles, params, pivot_options):
    return signal_base.drive(engine, candles, params, signal)
