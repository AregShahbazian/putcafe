"""MACD trend-following. Long while the MACD line is above its signal line,
short below — always-in / stop-and-reverse."""

from .. import indicators as ind
from . import signal_base


def signal(candles, params):
    cfg = signal_base.algo_params(params, fast=12, slow=26, signal=9)
    line, sig, _ = ind.macd(ind.closes(candles), int(cfg["fast"]), int(cfg["slow"]), int(cfg["signal"]))
    return [0 if m is None or s is None else (1 if m > s else -1 if m < s else 0) for m, s in zip(line, sig)]


def run(engine, candles, params, pivot_options):
    return signal_base.drive(engine, candles, params, signal)
