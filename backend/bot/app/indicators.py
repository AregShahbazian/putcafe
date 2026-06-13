"""Pure-Python technical indicators over a candle list (no numpy dependency).

Every function returns a list aligned 1:1 with `candles`; values that can't be
computed yet (not enough history) are `None`. No lookahead — index i only uses
candles 0..i."""

from __future__ import annotations


def closes(candles: list[dict]) -> list[float]:
    return [c["close"] for c in candles]


def sma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if period <= 0:
        return out
    run = 0.0
    for i, v in enumerate(values):
        run += v
        if i >= period:
            run -= values[i - period]
        if i >= period - 1:
            out[i] = run / period
    return out


def ema(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    k = 2.0 / (period + 1)
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(values: list[float], period: int = 14) -> list[float | None]:
    """Wilder's RSI."""
    out: list[float | None] = [None] * len(values)
    if len(values) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = values[i] - values[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    avg_gain = gains / period
    avg_loss = losses / period
    out[period] = _rsi_from(avg_gain, avg_loss)
    for i in range(period + 1, len(values)):
        d = values[i] - values[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(d, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-d, 0.0)) / period
        out[i] = _rsi_from(avg_gain, avg_loss)
    return out


def _rsi_from(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def macd(values, fast=12, slow=26, signal=9):
    """Returns (macd_line, signal_line, histogram)."""
    ef = ema(values, fast)
    es = ema(values, slow)
    line = [(a - b) if a is not None and b is not None else None for a, b in zip(ef, es)]
    dense = [v for v in line if v is not None]
    sig_dense = ema(dense, signal)
    sig: list[float | None] = [None] * len(values)
    j = 0
    for i, v in enumerate(line):
        if v is None:
            continue
        sig[i] = sig_dense[j]
        j += 1
    hist = [(m - s) if m is not None and s is not None else None for m, s in zip(line, sig)]
    return line, sig, hist


def bollinger(values, period=20, mult=2.0):
    """Returns (mid, upper, lower)."""
    mid = sma(values, period)
    upper: list[float | None] = [None] * len(values)
    lower: list[float | None] = [None] * len(values)
    for i in range(len(values)):
        if i < period - 1:
            continue
        window = values[i - period + 1 : i + 1]
        m = mid[i]
        sd = (sum((x - m) ** 2 for x in window) / period) ** 0.5
        upper[i] = m + mult * sd
        lower[i] = m - mult * sd
    return mid, upper, lower


def donchian(candles, period=20):
    """Returns (upper, lower): highest-high / lowest-low of the PRIOR `period`
    candles (excludes the current), so a breakout is a genuine new extreme."""
    upper: list[float | None] = [None] * len(candles)
    lower: list[float | None] = [None] * len(candles)
    for i in range(len(candles)):
        if i < period:
            continue
        window = candles[i - period : i]
        upper[i] = max(c["high"] for c in window)
        lower[i] = min(c["low"] for c in window)
    return upper, lower
