"""Pivot-breakout strategy, simulated over a candle range (stateless).

Trades the swing structure from `pivots.detect`: a stop-market breakout of the
most recent pivot in the breakout direction opens a position (long on up-break,
short on down-break); a TP/SL bracket sized off the opposite pivot (capped) is
set at entry; breaking the *current* opposite pivot closes-and-reverses; after a
TP/SL exit no re-entry until a fresh pivot confirms. One netted position at a
time. Intra-candle ordering uses the OHLC color heuristic (green O->L->H->C,
red O->H->L->C). Mirrors the positions-backend fee model so numbers line up.

This is a backtest simulation only — real resting/bracket orders and a hedge-mode
futures model are the separate `pc-futures-orders` effort."""

from . import pivots

TAKER_FEE = 0.001
SLIPPAGE = 0.0005


def _bracket(side: str, entry: float, opp: float | None, sl_cap: float, ratio: float):
    """SL% = capped distance to the opposite pivot (fallback to the cap); TP% = SL%·ratio."""
    sl_pct = sl_cap if opp is None else min(abs(entry - opp) / entry, sl_cap)
    tp_pct = sl_pct * ratio
    if side == "long":
        return entry * (1 - sl_pct), entry * (1 + tp_pct)
    return entry * (1 + sl_pct), entry * (1 - tp_pct)


def _path(candle: dict) -> list[str]:
    """Ordered extremes the price is assumed to visit within the candle."""
    return ["low", "high"] if candle["close"] >= candle["open"] else ["high", "low"]


def simulate(candles: list[dict], pivot_options, params) -> dict:
    lookback = pivot_options.lookback
    # Alternation forced on: the strategy needs clean alternating support/resistance.
    detected = pivots.detect(candles, lookback, alternation=True)

    ratio = float(params.tpSlRatio)
    sl_cap = float(params.slCapPct) / 100.0
    notional = float(params.quoteAmount)
    fees = bool(params.feesEnabled)
    equity = float(params.startingBalance)

    # Pivots indexed by the time they become known, walked alongside the candles.
    by_confirm = sorted(detected, key=lambda p: p["confirmedAt"])
    ci = 0
    last_high: dict | None = None
    last_low: dict | None = None

    trades: list[dict] = []
    pos: dict | None = None
    last_exit_time = -1
    wins = losses = 0

    def fee_of(price: float) -> float:
        return notional * TAKER_FEE if fees else 0.0

    def fill(price: float, buy: bool) -> float:
        if not fees:
            return price
        return price * (1 + SLIPPAGE) if buy else price * (1 - SLIPPAGE)

    def open_pos(side: str, level: float, candle: dict, fresh: bool = False):
        nonlocal pos
        buy = side == "long"
        # Gap-aware stop fill: a candle opening past the stop fills at the open.
        raw = max(level, candle["open"]) if buy else min(level, candle["open"])
        entry = fill(raw, buy)
        opp = (last_low["price"] if side == "long" else last_high["price"]) \
            if (last_low if side == "long" else last_high) else None
        sl_price, tp_price = _bracket(side, entry, opp, sl_cap, ratio)
        qty = notional / entry
        pos = {
            "side": side, "entryTime": candle["time"], "entryPrice": entry,
            "qty": qty, "slPrice": sl_price, "tpPrice": tp_price,
            "feePaid": fee_of(entry),
            # A reverse-opened position is evaluated only from the next candle.
            "_fresh": candle["time"] if fresh else None,
        }

    def close_pos(level: float, reason: str, candle: dict):
        nonlocal pos, equity, last_exit_time, wins, losses
        assert pos is not None
        buy = pos["side"] == "short"  # closing a short buys back
        raw = level
        # Gap-aware against the open in the adverse direction.
        if pos["side"] == "long":
            raw = min(level, candle["open"]) if candle["open"] < level else level
        else:
            raw = max(level, candle["open"]) if candle["open"] > level else level
        exit_px = fill(raw, buy)
        gross = pos["qty"] * (exit_px - pos["entryPrice"])
        if pos["side"] == "short":
            gross = -gross
        exit_fee = fee_of(exit_px)
        pnl = gross - pos["feePaid"] - exit_fee
        equity += pnl
        if pnl >= 0:
            wins += 1
        else:
            losses += 1
        trades.append({
            "side": pos["side"], "entryTime": pos["entryTime"], "entryPrice": pos["entryPrice"],
            "exitTime": candle["time"], "exitPrice": exit_px, "exitReason": reason,
            "qty": pos["qty"], "slPrice": pos["slPrice"], "tpPrice": pos["tpPrice"],
            "pnl": pnl, "feePaid": pos["feePaid"] + exit_fee,
        })
        last_exit_time = candle["time"]
        pos = None

    for candle in candles:
        t = candle["time"]
        # Reveal pivots confirmed by now.
        while ci < len(by_confirm) and by_confirm[ci]["confirmedAt"] <= t:
            p = by_confirm[ci]
            if p["type"] == "high":
                last_high = p
            else:
                last_low = p
            ci += 1

        for extreme in _path(candle):
            if pos is not None and pos.get("_fresh") == t:
                break  # a reverse just opened this position — evaluate it next candle
            if pos is None:
                # Re-arm gate: only pivots confirmed *after* the last flat exit arm a stop.
                hi = last_high if last_high and last_high["confirmedAt"] > last_exit_time else None
                lo = last_low if last_low and last_low["confirmedAt"] > last_exit_time else None
                if extreme == "high" and hi and candle["high"] >= hi["price"]:
                    open_pos("long", hi["price"], candle)
                elif extreme == "low" and lo and candle["low"] <= lo["price"]:
                    open_pos("short", lo["price"], candle)
                continue

            if pos["side"] == "long":
                if extreme == "low":
                    # Downside: whichever of SL / opposite-low is higher is hit first.
                    rev = last_low["price"] if last_low and last_low["price"] < pos["entryPrice"] else None
                    if rev is not None and rev > pos["slPrice"] and candle["low"] <= rev:
                        close_pos(rev, "reverse", candle)
                        open_pos("short", rev, candle, fresh=True)
                    elif candle["low"] <= pos["slPrice"]:
                        close_pos(pos["slPrice"], "sl", candle)
                elif extreme == "high" and candle["high"] >= pos["tpPrice"]:
                    close_pos(pos["tpPrice"], "tp", candle)
            else:  # short
                if extreme == "high":
                    rev = last_high["price"] if last_high and last_high["price"] > pos["entryPrice"] else None
                    if rev is not None and rev < pos["slPrice"] and candle["high"] >= rev:
                        close_pos(rev, "reverse", candle)
                        open_pos("long", rev, candle, fresh=True)
                    elif candle["high"] >= pos["slPrice"]:
                        close_pos(pos["slPrice"], "sl", candle)
                elif extreme == "low" and candle["low"] <= pos["tpPrice"]:
                    close_pos(pos["tpPrice"], "tp", candle)

    if pos is not None:
        trades.append({
            "side": pos["side"], "entryTime": pos["entryTime"], "entryPrice": pos["entryPrice"],
            "exitTime": None, "exitPrice": None, "exitReason": "open",
            "qty": pos["qty"], "slPrice": pos["slPrice"], "tpPrice": pos["tpPrice"],
            "pnl": None, "feePaid": pos["feePaid"],
        })

    realized = sum(t["pnl"] for t in trades if t["pnl"] is not None)
    return {
        "pivots": detected if pivot_options.enabled else None,
        "trades": trades,
        "equity": equity,
        "realizedPnl": realized,
        "wins": wins,
        "losses": losses,
    }
