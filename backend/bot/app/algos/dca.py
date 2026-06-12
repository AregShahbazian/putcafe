"""DCA, ported onto the futures engine: every `frequencySec` it places a market
**buy** that opens/accumulates a single long (leverage 1, no bracket), funded
from the free balance. It never brackets and, at ×1, never liquidates — a
buy-and-hold long that grows. When the free balance can't cover the next buy it
simply skips and retries (mirroring the old insufficient-balance behaviour)."""

from ..futures import FuturesEngine


def run(engine: FuturesEngine, candles: list[dict], params, pivot_options):
    quote_amount = float(getattr(params, "quoteAmount", 10))
    frequency_sec = int(getattr(params, "frequencySec", 7 * 24 * 3600))
    leverage = 1
    last_buy: int | None = None

    for candle in candles:
        t = candle["time"]
        due = last_buy is None or t - last_buy >= frequency_sec
        if not due:
            continue
        if not engine.can_fund(quote_amount):
            continue  # retry next candle once funded again
        # Market buy at the candle close (slippage adverse), accumulating a long.
        fill_px = engine.fill_price(candle["close"], buy=True)
        order = engine.place("entry", "market", "buy", fill_px, 0.0, t, position_side="long")
        pos = engine.add_market("long", fill_px, t, margin=quote_amount, leverage=leverage)
        order["qty"] = quote_amount * leverage / fill_px
        engine.fill_order(order, fill_px, t)
        order["tradeIdx"] = 0  # the single accumulating long is trade 0 (open)
        last_buy = t

    # Pivots are an indicator overlay only; DCA still surfaces them if enabled.
    if pivot_options.enabled:
        from .. import pivots
        return pivots.detect(candles, pivot_options.lookback, pivot_options.alternation)
    return None
