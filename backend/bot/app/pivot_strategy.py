"""Pivot-breakout strategy, simulated over a candle range (stateless).

Trades the swing structure from `pivots.detect`: a stop-market breakout of the
most recent pivot in the breakout direction opens a position (long on up-break,
short on down-break); a TP/SL bracket — SL a fixed % from entry, TP = SL%·ratio —
is set at entry; breaking the *current* opposite pivot closes-and-reverses; after a
TP/SL exit no re-entry until a fresh pivot confirms. One netted position at a
time. Intra-candle ordering uses the OHLC color heuristic (green O->L->H->C,
red O->H->L->C). Mirrors the positions-backend fee model so numbers line up,
except TP exits: those are resting limits — fill at their price or better, no
slippage (maker-fee modelling stays deferred to `pc-futures-orders`).

Futures-style isolated margin: `quoteAmount` is the margin per position,
notional = margin × leverage; the liquidation price caps a position's loss at
its margin, and an entry that can't be funded (equity < margin) marks the
session bust.

This is a backtest simulation only — real resting/bracket orders and a hedge-mode
futures model are the separate `pc-futures-orders` effort."""

from . import pivots

TAKER_FEE = 0.001
SLIPPAGE = 0.0005


def _bracket(side: str, entry: float, sl_pct: float, ratio: float):
    """SL leads: fixed distance from entry. TP follows: SL%·ratio."""
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
    sl_pct = float(params.slCapPct) / 100.0
    margin = float(params.quoteAmount)
    leverage = int(getattr(params, "leverage", 1))
    notional = margin * leverage
    fees = bool(params.feesEnabled)
    equity = float(params.startingBalance)
    # Adverse move that eats the whole margin, net of entry+exit fees.
    liq_pct = 1.0 / leverage - (2 * TAKER_FEE if fees else 0.0)

    # Pivots indexed by the time they become known, walked alongside the candles.
    by_confirm = sorted(detected, key=lambda p: p["confirmedAt"])
    ci = 0
    last_high: dict | None = None
    last_low: dict | None = None

    trades: list[dict] = []
    pos: dict | None = None
    last_exit_time = -1
    wins = losses = 0
    bust = False

    # Orders ledger: every order the strategy "places" (armed entry stops, the
    # TP/SL bracket, reverse market exits), with its full lifecycle.
    orders: list[dict] = []
    armed: dict[str, dict | None] = {"buy": None, "sell": None}

    def make_order(role: str, otype: str, side: str, price: float, qty: float,
                   t: int, pct: float | None = None) -> dict:
        o = {
            "id": len(orders), "role": role, "type": otype, "side": side,
            "price": price, "qty": qty, "pct": pct, "createdAt": t,
            "status": "open", "filledAt": None, "fillPrice": None,
            "cancelledAt": None, "tradeIdx": None,
        }
        orders.append(o)
        return o

    def fill_order(o: dict, price: float, t: int):
        o["status"] = "filled"
        o["filledAt"] = t
        o["fillPrice"] = price

    def cancel_order(o: dict | None, t: int):
        if o is not None and o["status"] == "open":
            o["status"] = "cancelled"
            o["cancelledAt"] = t

    def sync_armed(side: str, price: float | None, t: int):
        """Keep the armed entry stop in step with the gated pivot: a moved level
        cancels + recreates, a vanished one cancels."""
        cur = armed[side]
        if cur is not None and (price is None or cur["price"] != price):
            cancel_order(cur, t)
            armed[side] = None
        if price is not None and armed[side] is None:
            armed[side] = make_order("entry", "stop_market", side, price, notional / price, t)

    def fee_of(price: float) -> float:
        return notional * TAKER_FEE if fees else 0.0

    def fill(price: float, buy: bool) -> float:
        if not fees:
            return price
        return price * (1 + SLIPPAGE) if buy else price * (1 - SLIPPAGE)

    def open_pos(side: str, level: float, candle: dict, fresh: bool = False):
        nonlocal pos, bust
        t = candle["time"]
        if equity < margin:
            # The triggered stop can't be funded — the session is done trading.
            bust = True
            cancel_order(armed["buy"], t)
            cancel_order(armed["sell"], t)
            armed["buy"] = armed["sell"] = None
            return
        buy = side == "long"
        # Gap-aware stop fill: a candle opening past the stop fills at the open.
        raw = max(level, candle["open"]) if buy else min(level, candle["open"])
        entry = fill(raw, buy)
        sl_price, tp_price = _bracket(side, entry, sl_pct, ratio)
        liq_price = entry * (1 - liq_pct) if buy else entry * (1 + liq_pct)
        qty = notional / entry
        # Fill the armed stop that triggered (a reverse entry has none — its
        # stop-market order materializes and fills on the reversal candle);
        # the opposite armed stop dies with the flat state.
        entry_side = "buy" if buy else "sell"
        entry_order = armed[entry_side]
        if entry_order is None:
            entry_order = make_order("entry", "stop_market", entry_side, level, qty, t)
        entry_order["qty"] = qty
        fill_order(entry_order, entry, t)
        armed[entry_side] = None
        cancel_order(armed["buy" if not buy else "sell"], t)
        armed["buy" if not buy else "sell"] = None
        pct_of = lambda price: (price - entry) / entry * 100.0
        tp_order = make_order("tp", "limit", "sell" if buy else "buy", tp_price, qty, t, pct_of(tp_price))
        sl_order = make_order("sl", "stop_market", "sell" if buy else "buy", sl_price, qty, t, pct_of(sl_price))
        pos = {
            "side": side, "entryTime": t, "entryPrice": entry,
            "qty": qty, "slPrice": sl_price, "tpPrice": tp_price,
            "liqPrice": liq_price, "feePaid": fee_of(entry),
            "_orders": {"entry": entry_order, "tp": tp_order, "sl": sl_order},
            # A reverse-opened position is evaluated only from the next candle.
            "_fresh": t if fresh else None,
        }

    def stop_of(p: dict) -> tuple[float, str]:
        """Effective protective stop: SL or liq, whichever is closer to entry."""
        if p["side"] == "long":
            return (p["liqPrice"], "liq") if p["liqPrice"] > p["slPrice"] else (p["slPrice"], "sl")
        return (p["liqPrice"], "liq") if p["liqPrice"] < p["slPrice"] else (p["slPrice"], "sl")

    def close_pos(level: float, reason: str, candle: dict):
        nonlocal pos, equity, last_exit_time, wins, losses
        assert pos is not None
        buy = pos["side"] == "short"  # closing a short buys back
        long = pos["side"] == "long"
        if reason == "tp":
            # Resting limit: fills at its price or better (favorable gap -> open), no slippage.
            exit_px = max(level, candle["open"]) if long else min(level, candle["open"])
        else:
            # Stop-market: fills at the trigger or worse (adverse gap -> open), with slippage.
            raw = min(level, candle["open"]) if long else max(level, candle["open"])
            exit_px = fill(raw, buy)
        gross = pos["qty"] * (exit_px - pos["entryPrice"])
        if pos["side"] == "short":
            gross = -gross
        exit_fee = fee_of(exit_px)
        # Isolated margin: a position can never lose more than its margin.
        pnl = max(gross - pos["feePaid"] - exit_fee, -margin)
        equity += pnl
        if pnl >= 0:
            wins += 1
        else:
            losses += 1
        trades.append({
            "side": pos["side"], "entryTime": pos["entryTime"], "entryPrice": pos["entryPrice"],
            "exitTime": candle["time"], "exitPrice": exit_px, "exitReason": reason,
            "qty": pos["qty"], "slPrice": pos["slPrice"], "tpPrice": pos["tpPrice"],
            "liqPrice": pos["liqPrice"], "notional": notional, "margin": margin,
            "pnl": pnl, "feePaid": pos["feePaid"] + exit_fee,
        })
        # Resolve the bracket: the exit reason fills its order, the other leg is
        # cancelled; a reverse cancels both and closes with a market order.
        t = candle["time"]
        po = pos["_orders"]
        if reason == "tp":
            fill_order(po["tp"], exit_px, t)
            cancel_order(po["sl"], t)
        elif reason == "sl":
            fill_order(po["sl"], exit_px, t)
            cancel_order(po["tp"], t)
        elif reason == "liq":
            # Forced market close by the exchange — both bracket legs die.
            cancel_order(po["tp"], t)
            cancel_order(po["sl"], t)
            liq_order = make_order("liq", "market", "buy" if buy else "sell", exit_px, pos["qty"], t)
            fill_order(liq_order, exit_px, t)
            po["liq"] = liq_order
        else:  # reverse
            cancel_order(po["tp"], t)
            cancel_order(po["sl"], t)
            exit_order = make_order("exit", "market", "buy" if buy else "sell", exit_px, pos["qty"], t)
            fill_order(exit_order, exit_px, t)
            po["exit"] = exit_order
        idx = len(trades) - 1
        for o in po.values():
            o["tradeIdx"] = idx
        last_exit_time = t
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

        # While flat, the armed entry stops mirror the gated pivots (the same
        # levels the entry checks below use; pivots only change between candles).
        # A bust session arms nothing — it can never fund an entry again.
        if pos is None and not bust:
            hi = last_high if last_high and last_high["confirmedAt"] > last_exit_time else None
            lo = last_low if last_low and last_low["confirmedAt"] > last_exit_time else None
            sync_armed("buy", hi["price"] if hi else None, t)
            sync_armed("sell", lo["price"] if lo else None, t)

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
                    stop_px, stop_reason = stop_of(pos)
                    # Downside: whichever of stop / opposite-low is higher is hit first.
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

    if pos is not None:
        trades.append({
            "side": pos["side"], "entryTime": pos["entryTime"], "entryPrice": pos["entryPrice"],
            "exitTime": None, "exitPrice": None, "exitReason": "open",
            "qty": pos["qty"], "slPrice": pos["slPrice"], "tpPrice": pos["tpPrice"],
            "liqPrice": pos["liqPrice"], "notional": notional, "margin": margin,
            "pnl": None, "feePaid": pos["feePaid"],
        })
        # Still-open position: entry is filled, the bracket stays open.
        for o in pos["_orders"].values():
            o["tradeIdx"] = len(trades) - 1

    realized = sum(t["pnl"] for t in trades if t["pnl"] is not None)
    return {
        "pivots": detected if pivot_options.enabled else None,
        "trades": trades,
        "orders": orders,
        "equity": equity,
        "realizedPnl": realized,
        "wins": wins,
        "losses": losses,
        "leverage": leverage,
        "bust": bust,
    }
