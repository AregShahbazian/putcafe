"""Swing high/low (pivot) detection: a candle is a swing high (low) when its
high (low) is the extreme of `lookback` candles on each side. No lookahead — a
pivot only exists once the candle `lookback` positions later has been seen
(`confirmedAt`). Optional alternation collapses consecutive same-type pivots
to the strongest, yielding strictly alternating high/low structure."""

DEFAULT_OPTIONS = {"enabled": False, "lookback": 3, "alternation": True}


def detect(candles: list[dict], lookback: int = 3, alternation: bool = True) -> list[dict]:
    pivots = []
    for i in range(lookback, len(candles) - lookback):
        c = candles[i]
        window = candles[i - lookback : i] + candles[i + 1 : i + lookback + 1]
        confirmed_at = candles[i + lookback]["time"]
        if c["high"] >= max(w["high"] for w in window):
            pivots.append({"time": c["time"], "type": "high", "price": c["high"], "confirmedAt": confirmed_at})
        elif c["low"] <= min(w["low"] for w in window):
            pivots.append({"time": c["time"], "type": "low", "price": c["low"], "confirmedAt": confirmed_at})
    return _alternate(pivots) if alternation else pivots


def _alternate(pivots: list[dict]) -> list[dict]:
    result: list[dict] = []
    for p in pivots:
        last = result[-1] if result else None
        if last is None or p["type"] != last["type"]:
            result.append(p)
        elif (p["type"] == "high" and p["price"] > last["price"]) or (
            p["type"] == "low" and p["price"] < last["price"]
        ):
            result[-1] = p
    return result
