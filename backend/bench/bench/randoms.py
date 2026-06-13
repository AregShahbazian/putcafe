"""Random backtest window — direct port of frontend/src/util/randomRange.ts
(pc-randoms). Pure: the only entropy is the injected `rand`, so the resolved
absolute [start, end] is reproducible and stored on the result row — the dice
stay out of the reproducible part."""

DEFAULT_MIN_BARS = 200
DEFAULT_MAX_BARS = 1000


def roll_random_range(earliest: int, latest: int, interval_s: int,
                      min_bars: int = DEFAULT_MIN_BARS,
                      max_bars: int = DEFAULT_MAX_BARS,
                      rand=None) -> tuple[int, int]:
    """A candle-aligned (start, end) in unix-seconds within [earliest, latest],
    sized between min/max bars and clamped to the available history. `rand` is a
    zero-arg callable returning [0,1) (e.g. random.Random(seed).random)."""
    import random as _random
    rand = rand or _random.random
    total_bars = (latest - earliest) // interval_s
    if total_bars < 1:
        raise ValueError("not enough history to pick a range")
    mx = min(max_bars, total_bars)
    mn = max(1, min(min_bars, mx))
    window_bars = mn + int(rand() * (mx - mn + 1))
    offset_bars = int(rand() * (total_bars - window_bars + 1))
    start = earliest + offset_bars * interval_s
    return start, start + window_bars * interval_s
