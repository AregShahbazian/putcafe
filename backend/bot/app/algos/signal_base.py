"""Shared driver for the indicator algos (MA-cross, RSI, Bollinger, Donchian,
MACD) on the futures order protocol.

An indicator algo provides `signal(candles, params) -> list[int]` (−1 short /
0 flat / +1 long, the desired direction as of each candle's CLOSE, no lookahead).
This driver turns that target into bracketed, reversible trades on the
`FuturesEngine`, exactly mirroring how `algos/pivot.py` drives it — the engine
owns all the arithmetic:

  * Entry: a market order at the signal candle's close; a reduce-only TP (limit)
    + SL (stop_market) bracket is placed (SL a fixed % from entry, TP = SL%·ratio).
  * Each held candle, the bracket is matched against the OHLC path; SL/liq fills
    at trigger-or-worse, TP at price-or-better — same honesty as pivot.
  * An opposite signal closes-and-reverses at the candle close; a 0 signal flattens.
  * A position opened on a reverse is only evaluated from the next candle.

One netted position at a time (long XOR short)."""

from ..futures import FuturesEngine, path_of


def algo_params(params, **defaults):
    """Read an indicator algo's knobs from params.algoParams, with defaults."""
    ap = getattr(params, "algoParams", None) or {}
    return {k: ap.get(k, v) for k, v in defaults.items()}


def _bracket(side: str, entry: float, sl_pct: float, ratio: float):
    tp_pct = sl_pct * ratio
    if side == "long":
        return entry * (1 - sl_pct), entry * (1 + tp_pct)
    return entry * (1 + sl_pct), entry * (1 - tp_pct)


def drive(engine: FuturesEngine, candles: list[dict], params, signal_fn):
    signals = signal_fn(candles, params)
    ratio = float(params.tpSlRatio)
    sl_pct = float(params.slCapPct) / 100.0
    margin = float(params.quoteAmount)
    leverage = int(getattr(params, "leverage", 1))

    pos_orders: dict[str, dict] = {}
    fresh_at: int | None = None

    def cur_side():
        if engine.positions["long"] is not None:
            return "long"
        if engine.positions["short"] is not None:
            return "short"
        return None

    def open_pos(side: str, candle: dict, fresh: bool):
        nonlocal fresh_at
        t = candle["time"]
        if not engine.can_fund(margin):
            engine.mark_bust(t)
            return
        buy = side == "long"
        entry = engine.fill_price(candle["close"], buy)
        sl_price, tp_price = _bracket(side, entry, sl_pct, ratio)
        pos = engine.open_position(side, entry, t, margin=margin, leverage=leverage,
                                   sl_price=sl_price, tp_price=tp_price)
        qty = pos["qty"]
        entry_side = "buy" if buy else "sell"
        entry_order = engine.place("entry", "market", entry_side, entry, qty, t, position_side=side)
        engine.fill_order(entry_order, entry, t)
        opp = "sell" if buy else "buy"
        pct_of = lambda price: (price - entry) / entry * 100.0
        tp_order = engine.place("tp", "limit", opp, tp_price, qty, t,
                                position_side=side, reduce_only=True, pct=pct_of(tp_price))
        sl_order = engine.place("sl", "stop_market", opp, sl_price, qty, t,
                                position_side=side, reduce_only=True, pct=pct_of(sl_price))
        pos_orders.clear()
        pos_orders.update({"entry": entry_order, "tp": tp_order, "sl": sl_order})
        if fresh:
            fresh_at = t

    def stop_of(pos):
        if pos["side"] == "long":
            return (pos["liqPrice"], "liq") if pos["liqPrice"] > pos["slPrice"] else (pos["slPrice"], "sl")
        return (pos["liqPrice"], "liq") if pos["liqPrice"] < pos["slPrice"] else (pos["slPrice"], "sl")

    def close_pos(level: float, reason: str, candle: dict):
        side = cur_side()
        pos = engine.positions[side]
        long = side == "long"
        buy = side == "short"
        if reason == "tp":
            exit_px = max(level, candle["open"]) if long else min(level, candle["open"])
        elif reason in ("sl", "liq"):
            raw = min(level, candle["open"]) if long else max(level, candle["open"])
            exit_px = engine.fill_price(raw, buy)
        else:  # reverse / flat exit at the signal candle's close
            exit_px = engine.fill_price(level, buy)
        t = candle["time"]
        idx = engine.close_position(side, exit_px, reason, t)
        po = pos_orders
        if reason == "tp":
            engine.fill_order(po["tp"], exit_px, t); engine.cancel(po["sl"], t)
        elif reason == "sl":
            engine.fill_order(po["sl"], exit_px, t); engine.cancel(po["tp"], t)
        else:
            engine.cancel(po["tp"], t); engine.cancel(po["sl"], t)
            role = "liq" if reason == "liq" else "exit"
            ex = engine.place(role, "market", "buy" if buy else "sell", exit_px, pos["qty"], t,
                              position_side=side, reduce_only=True)
            engine.fill_order(ex, exit_px, t)
            po[role] = ex
        for o in po.values():
            o["tradeIdx"] = idx

    for i, candle in enumerate(candles):
        sig = signals[i] if i < len(signals) else 0

        # 1) Bracket matching for a position carried into this candle.
        if cur_side() is not None and fresh_at != candle["time"]:
            for extreme in path_of(candle):
                side = cur_side()
                if side is None:
                    break
                pos = engine.positions[side]
                if side == "long":
                    if extreme == "low":
                        stop_px, reason = stop_of(pos)
                        if candle["low"] <= stop_px:
                            close_pos(stop_px, reason, candle)
                    elif extreme == "high" and candle["high"] >= pos["tpPrice"]:
                        close_pos(pos["tpPrice"], "tp", candle)
                else:
                    if extreme == "high":
                        stop_px, reason = stop_of(pos)
                        if candle["high"] >= stop_px:
                            close_pos(stop_px, reason, candle)
                    elif extreme == "low" and candle["low"] <= pos["tpPrice"]:
                        close_pos(pos["tpPrice"], "tp", candle)

        # 2) Act on the signal at this candle's close.
        want = "long" if sig > 0 else "short" if sig < 0 else None
        side = cur_side()
        if side is None:
            if want is not None and not engine.bust:
                open_pos(want, candle, fresh=True)
        elif want is None:
            close_pos(candle["close"], "exit", candle)
        elif want != side:
            close_pos(candle["close"], "reverse", candle)
            open_pos(want, candle, fresh=True)

    # Link a still-open position's bracket to its (appended) open trade row.
    if cur_side() is not None:
        open_idx = len(engine.trades)
        for o in pos_orders.values():
            o["tradeIdx"] = open_idx

    return None  # indicator algos draw no pivots
