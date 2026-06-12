"""Pivot-breakout algo, ported onto the futures order protocol.

Same swing-structure logic as before, now expressed as order actions on the
`FuturesEngine`: while flat, resting stop-market entry orders sit at the gated
high/low pivots ("armed stops"); on a fill, a reduce-only TP (limit) + SL
(stop_market) bracket is placed; breaking the current opposite pivot closes the
position and reverses. One netted position at a time (long XOR short). The math
is identical to the former `pivot_strategy.simulate`, so results are unchanged —
only the bookkeeping now lives in the engine."""

from .. import pivots
from ..futures import FuturesEngine, path_of


def _bracket(side: str, entry: float, sl_pct: float, ratio: float):
    """SL leads: fixed distance from entry. TP follows: SL%·ratio."""
    tp_pct = sl_pct * ratio
    if side == "long":
        return entry * (1 - sl_pct), entry * (1 + tp_pct)
    return entry * (1 + sl_pct), entry * (1 - tp_pct)


def run(engine: FuturesEngine, candles: list[dict], params, pivot_options):
    lookback = pivot_options.lookback
    # Alternation forced on: the strategy needs clean alternating support/resistance.
    detected = pivots.detect(candles, lookback, alternation=True)

    ratio = float(params.tpSlRatio)
    sl_pct = float(params.slCapPct) / 100.0
    margin = float(params.quoteAmount)
    leverage = int(getattr(params, "leverage", 1))
    notional = margin * leverage

    by_confirm = sorted(detected, key=lambda p: p["confirmedAt"])
    ci = 0
    last_high: dict | None = None
    last_low: dict | None = None

    # The position's bracket orders, kept so close-out can resolve them.
    armed: dict[str, dict | None] = {"buy": None, "sell": None}
    pos_orders: dict[str, dict] = {}
    last_exit_time = -1
    fresh_at: int | None = None  # candle time a reverse just opened on

    def cur_side() -> str | None:
        if engine.positions["long"] is not None:
            return "long"
        if engine.positions["short"] is not None:
            return "short"
        return None

    def sync_armed(side: str, price: float | None, t: int):
        cur = armed[side]
        if cur is not None and (price is None or cur["price"] != price):
            engine.cancel(cur, t)
            armed[side] = None
        if price is not None and armed[side] is None:
            armed[side] = engine.place("entry", "stop_market", side, price, notional / price, t,
                                       position_side="long" if side == "buy" else "short")

    def open_pos(side: str, level: float, candle: dict, fresh: bool = False):
        nonlocal fresh_at
        t = candle["time"]
        if not engine.can_fund(margin):
            engine.mark_bust(t)
            engine.cancel(armed["buy"], t); engine.cancel(armed["sell"], t)
            armed["buy"] = armed["sell"] = None
            return
        buy = side == "long"
        raw = max(level, candle["open"]) if buy else min(level, candle["open"])
        entry = engine.fill_price(raw, buy)
        sl_price, tp_price = _bracket(side, entry, sl_pct, ratio)
        pos = engine.open_position(side, entry, t, margin=margin, leverage=leverage,
                                   sl_price=sl_price, tp_price=tp_price)
        qty = pos["qty"]
        # Fill the armed stop that triggered (a reverse entry has none yet).
        entry_side = "buy" if buy else "sell"
        entry_order = armed[entry_side]
        if entry_order is None:
            entry_order = engine.place("entry", "stop_market", entry_side, level, qty, t,
                                       position_side=side)
        entry_order["qty"] = qty
        engine.fill_order(entry_order, entry, t)
        armed[entry_side] = None
        opp = "sell" if buy else "buy"
        engine.cancel(armed[opp], t); armed[opp] = None
        pct_of = lambda price: (price - entry) / entry * 100.0
        tp_order = engine.place("tp", "limit", opp, tp_price, qty, t,
                                position_side=side, reduce_only=True, pct=pct_of(tp_price))
        sl_order = engine.place("sl", "stop_market", opp, sl_price, qty, t,
                                position_side=side, reduce_only=True, pct=pct_of(sl_price))
        pos_orders.clear()
        pos_orders.update({"entry": entry_order, "tp": tp_order, "sl": sl_order})
        if fresh:
            fresh_at = t

    def stop_of(pos: dict) -> tuple[float, str]:
        if pos["side"] == "long":
            return (pos["liqPrice"], "liq") if pos["liqPrice"] > pos["slPrice"] else (pos["slPrice"], "sl")
        return (pos["liqPrice"], "liq") if pos["liqPrice"] < pos["slPrice"] else (pos["slPrice"], "sl")

    def close_pos(level: float, reason: str, candle: dict):
        nonlocal last_exit_time
        side = cur_side()
        pos = engine.positions[side]
        long = side == "long"
        buy = side == "short"  # closing a short buys back
        if reason == "tp":
            exit_px = max(level, candle["open"]) if long else min(level, candle["open"])
        else:
            raw = min(level, candle["open"]) if long else max(level, candle["open"])
            exit_px = engine.fill_price(raw, buy)
        t = candle["time"]
        idx = engine.close_position(side, exit_px, reason, t)
        po = pos_orders
        if reason == "tp":
            engine.fill_order(po["tp"], exit_px, t); engine.cancel(po["sl"], t)
        elif reason == "sl":
            engine.fill_order(po["sl"], exit_px, t); engine.cancel(po["tp"], t)
        elif reason == "liq":
            engine.cancel(po["tp"], t); engine.cancel(po["sl"], t)
            po["liq"] = engine.place("liq", "market", "buy" if buy else "sell", exit_px, pos["qty"], t,
                                     position_side=side, reduce_only=True)
            engine.fill_order(po["liq"], exit_px, t)
        else:  # reverse
            engine.cancel(po["tp"], t); engine.cancel(po["sl"], t)
            po["exit"] = engine.place("exit", "market", "buy" if buy else "sell", exit_px, pos["qty"], t,
                                      position_side=side, reduce_only=True)
            engine.fill_order(po["exit"], exit_px, t)
        for o in po.values():
            o["tradeIdx"] = idx
        last_exit_time = t

    for candle in candles:
        t = candle["time"]
        while ci < len(by_confirm) and by_confirm[ci]["confirmedAt"] <= t:
            p = by_confirm[ci]
            if p["type"] == "high":
                last_high = p
            else:
                last_low = p
            ci += 1

        if cur_side() is None and not engine.bust:
            hi = last_high if last_high and last_high["confirmedAt"] > last_exit_time else None
            lo = last_low if last_low and last_low["confirmedAt"] > last_exit_time else None
            sync_armed("buy", hi["price"] if hi else None, t)
            sync_armed("sell", lo["price"] if lo else None, t)

        for extreme in path_of(candle):
            if cur_side() is not None and fresh_at == t:
                break  # a reverse just opened this position — evaluate it next candle
            side = cur_side()
            if side is None:
                hi = last_high if last_high and last_high["confirmedAt"] > last_exit_time else None
                lo = last_low if last_low and last_low["confirmedAt"] > last_exit_time else None
                if extreme == "high" and hi and candle["high"] >= hi["price"]:
                    open_pos("long", hi["price"], candle)
                elif extreme == "low" and lo and candle["low"] <= lo["price"]:
                    open_pos("short", lo["price"], candle)
                continue

            pos = engine.positions[side]
            if side == "long":
                if extreme == "low":
                    stop_px, stop_reason = stop_of(pos)
                    rev = last_low["price"] if last_low and last_low["price"] < pos["entryPrice"] else None
                    if rev is not None and rev > stop_px and candle["low"] <= rev:
                        close_pos(rev, "reverse", candle)
                        open_pos("short", rev, candle, fresh=True)
                    elif candle["low"] <= stop_px:
                        close_pos(stop_px, stop_reason, candle)
                elif extreme == "high" and candle["high"] >= pos["tpPrice"]:
                    close_pos(pos["tpPrice"], "tp", candle)
            else:  # short
                if extreme == "high":
                    stop_px, stop_reason = stop_of(pos)
                    rev = last_high["price"] if last_high and last_high["price"] > pos["entryPrice"] else None
                    if rev is not None and rev < stop_px and candle["high"] >= rev:
                        close_pos(rev, "reverse", candle)
                        open_pos("long", rev, candle, fresh=True)
                    elif candle["high"] >= stop_px:
                        close_pos(stop_px, stop_reason, candle)
                elif extreme == "low" and candle["low"] <= pos["tpPrice"]:
                    close_pos(pos["tpPrice"], "tp", candle)

    # Link a still-open position's bracket to its (appended) open trade row.
    if cur_side() is not None:
        open_idx = len(engine.trades)  # open trades are appended after closed ones
        for o in pos_orders.values():
            o["tradeIdx"] = open_idx

    return detected if pivot_options.enabled else None
