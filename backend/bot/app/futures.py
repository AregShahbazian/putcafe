"""Hedge-mode isolated-margin futures matching engine (stateless backtest).

The single source of truth for every algo. It owns positions (long and short
held simultaneously, each with its own isolated margin and leverage), the order
ledger (resting orders persisting across candles), balances/equity, liquidation,
fees and the events stream. Algos (`algos/`) drive it through the **order
protocol** — `place / cancel / amend` order actions plus `open_position /
close_position` — and never touch the arithmetic.

Fill honesty: resting orders match against each candle's OHLC along a
deterministic intra-candle path (green O→L→H→C, red O→H→L→C); an order fills
only when the range actually crosses its price (no lookahead). Limits fill at
price-or-better (favourable gap → open), no slippage; stop/market fills at the
trigger-or-worse with slippage. Conflicting crossings within one candle resolve
by path order — pessimistic for the strategy. Loss on a side is capped at its
isolated margin (liquidation).

The mechanics are lifted verbatim from the former `pivot_strategy` so the ported
pivot algo reproduces its numbers exactly. Spot is gone — every session is
futures now."""

TAKER_FEE = 0.001
SLIPPAGE = 0.0005


def path_of(candle: dict) -> list[str]:
    """Ordered extremes the price is assumed to visit within the candle."""
    return ["low", "high"] if candle["close"] >= candle["open"] else ["high", "low"]


class FuturesEngine:
    def __init__(self, *, starting_balance: float, fees: bool):
        self.fees = bool(fees)
        self.equity = float(starting_balance)
        self.starting_balance = float(starting_balance)
        # Free (uncommitted) balance — margin is locked here while a position is
        # open and returned with PnL on close. For a single-position algo (pivot)
        # `free == equity` whenever flat, so its bust check is unchanged.
        self.free = float(starting_balance)
        # Hedge mode: a long and a short can coexist. Algos here use one at a
        # time, but the engine never assumes that.
        self.positions: dict[str, dict | None] = {"long": None, "short": None}
        self.orders: list[dict] = []
        self.trades: list[dict] = []
        self.events: list[dict] = []
        self.wins = 0
        self.losses = 0
        self.bust = False

    # --- order protocol ----------------------------------------------------

    def place(self, role: str, otype: str, side: str, price: float, qty: float,
              t: int, *, position_side: str, reduce_only: bool = False,
              pct: float | None = None) -> dict:
        o = {
            "id": len(self.orders), "role": role, "type": otype, "side": side,
            "positionSide": position_side, "reduceOnly": reduce_only,
            "price": price, "qty": qty, "pct": pct, "createdAt": t,
            "status": "open", "filledAt": None, "fillPrice": None,
            "cancelledAt": None, "tradeIdx": None,
        }
        self.orders.append(o)
        return o

    def fill_order(self, o: dict, price: float, t: int):
        o["status"] = "filled"
        o["filledAt"] = t
        o["fillPrice"] = price

    def cancel(self, o: dict | None, t: int):
        if o is not None and o["status"] == "open":
            o["status"] = "cancelled"
            o["cancelledAt"] = t

    def amend(self, o: dict | None, t: int, *, price: float | None = None,
              qty: float | None = None):
        """Move a live order (a moved level cancels + re-places, mirroring an
        exchange amend so the ledger keeps an honest history)."""
        if o is None or o["status"] != "open":
            return None
        if (price is None or o["price"] == price) and (qty is None or o["qty"] == qty):
            return o
        self.cancel(o, t)
        return self.place(o["role"], o["type"], o["side"], price if price is not None else o["price"],
                          qty if qty is not None else o["qty"], t,
                          position_side=o["positionSide"], reduce_only=o["reduceOnly"], pct=o["pct"])

    # --- fee / fill helpers ------------------------------------------------

    def fee_of(self, notional: float) -> float:
        return notional * TAKER_FEE if self.fees else 0.0

    def fill_price(self, price: float, buy: bool) -> float:
        if not self.fees:
            return price
        return price * (1 + SLIPPAGE) if buy else price * (1 - SLIPPAGE)

    # --- position mechanics ------------------------------------------------

    def can_fund(self, margin: float) -> bool:
        return self.free >= margin

    def _liq_price(self, side: str, entry_px: float, leverage: int) -> float:
        liq_pct = 1.0 / leverage - (2 * TAKER_FEE if self.fees else 0.0)
        return entry_px * (1 - liq_pct) if side == "long" else entry_px * (1 + liq_pct)

    def open_position(self, side: str, entry_px: float, t: int, *,
                      margin: float, leverage: int,
                      sl_price: float | None = None, tp_price: float | None = None) -> dict:
        """Open a fresh isolated-margin position (caller pre-checks `can_fund`).
        `entry_px` is the already-filled price. Computes the liquidation price
        (adverse move that eats the whole margin net of round-trip fees).
        `sl_price`/`tp_price` are the algo's bracket levels, carried for the
        chart/overview (None for bracket-less algos like DCA)."""
        notional = margin * leverage
        qty = notional / entry_px
        self.free -= margin
        pos = {
            "side": side, "entryTime": t, "entryPrice": entry_px, "qty": qty,
            "margin": margin, "leverage": leverage, "notional": notional,
            "liqPrice": self._liq_price(side, entry_px, leverage), "feePaid": self.fee_of(notional),
            "slPrice": sl_price, "tpPrice": tp_price,
        }
        self.positions[side] = pos
        self.events.append({"time": t, "kind": "open", "side": side,
                            "price": entry_px, "qty": qty})
        return pos

    def add_market(self, side: str, entry_px: float, t: int, *,
                   margin: float, leverage: int) -> dict:
        """Open or average-into a position (DCA-style accumulation). Adds margin
        and qty, recomputes the average entry, notional and liquidation."""
        self.free -= margin
        add_notional = margin * leverage
        add_qty = add_notional / entry_px
        existing = self.positions[side]
        if existing is None:
            return self._open_via_add(side, entry_px, t, margin, leverage, add_notional, add_qty)
        new_qty = existing["qty"] + add_qty
        new_entry = (existing["qty"] * existing["entryPrice"] + add_qty * entry_px) / new_qty
        existing["qty"] = new_qty
        existing["entryPrice"] = new_entry
        existing["margin"] += margin
        existing["notional"] += add_notional
        existing["leverage"] = leverage
        existing["liqPrice"] = self._liq_price(side, new_entry, leverage)
        existing["feePaid"] += self.fee_of(add_notional)
        self.events.append({"time": t, "kind": "add", "side": side,
                            "price": entry_px, "qty": add_qty})
        return existing

    def _open_via_add(self, side, entry_px, t, margin, leverage, notional, qty) -> dict:
        pos = {
            "side": side, "entryTime": t, "entryPrice": entry_px, "qty": qty,
            "margin": margin, "leverage": leverage, "notional": notional,
            "liqPrice": self._liq_price(side, entry_px, leverage), "feePaid": self.fee_of(notional),
        }
        self.positions[side] = pos
        self.events.append({"time": t, "kind": "open", "side": side,
                            "price": entry_px, "qty": qty})
        return pos

    def close_position(self, side: str, exit_px: float, reason: str, t: int):
        """Realize a side at `exit_px` (already gap/slippage-adjusted by the
        caller's matching). PnL is capped at the side's isolated margin."""
        pos = self.positions[side]
        assert pos is not None
        gross = pos["qty"] * (exit_px - pos["entryPrice"])
        if side == "short":
            gross = -gross
        # Fee on the position's notional (entry and exit symmetric), as the
        # former pivot sim charged it — keeps PnL byte-for-byte on the port.
        exit_fee = self.fee_of(pos["notional"])
        pnl = max(gross - pos["feePaid"] - exit_fee, -pos["margin"])
        self.equity += pnl
        self.free += pos["margin"] + pnl  # release the locked margin with its result
        if pnl >= 0:
            self.wins += 1
        else:
            self.losses += 1
        self.trades.append({
            "side": side, "entryTime": pos["entryTime"], "entryPrice": pos["entryPrice"],
            "exitTime": t, "exitPrice": exit_px, "exitReason": reason,
            "qty": pos["qty"], "margin": pos["margin"], "leverage": pos["leverage"],
            "notional": pos["notional"], "liqPrice": pos["liqPrice"],
            "slPrice": pos.get("slPrice"), "tpPrice": pos.get("tpPrice"),
            "pnl": pnl, "feePaid": pos["feePaid"] + exit_fee,
        })
        self.events.append({"time": t, "kind": reason, "side": side,
                            "price": exit_px, "pnl": pnl})
        self.positions[side] = None
        return len(self.trades) - 1

    def mark_bust(self, t: int):
        self.bust = True
        self.events.append({"time": t, "kind": "bust"})

    # --- snapshot ----------------------------------------------------------

    def snapshot(self, *, leverage: int, pivots) -> dict:
        realized = sum(tr["pnl"] for tr in self.trades if tr["pnl"] is not None)
        # Any position still open at the end of the range is reported as an
        # open trade (nulls for exit), entry already filled.
        open_trades = []
        for side in ("long", "short"):
            pos = self.positions[side]
            if pos is not None:
                open_trades.append({
                    "side": side, "entryTime": pos["entryTime"], "entryPrice": pos["entryPrice"],
                    "exitTime": None, "exitPrice": None, "exitReason": "open",
                    "qty": pos["qty"], "margin": pos["margin"], "leverage": pos["leverage"],
                    "notional": pos["notional"], "liqPrice": pos["liqPrice"],
                    "slPrice": pos.get("slPrice"), "tpPrice": pos.get("tpPrice"),
                    "pnl": None, "feePaid": pos["feePaid"],
                })
        return {
            "pivots": pivots,
            "positions": self.positions,
            "trades": self.trades + open_trades,
            "orders": self.orders,
            "events": self.events,
            "equity": self.equity,
            "realizedPnl": realized,
            "wins": self.wins,
            "losses": self.losses,
            "leverage": leverage,
            "bust": self.bust,
        }
