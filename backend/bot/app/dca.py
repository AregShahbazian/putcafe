"""DCA (buy-only): buy `quote_amount` on the first step, then again whenever
`frequency_sec` has elapsed since the last trade (per positions-backend state)."""


def decide(config: dict, candle: dict, last_trade_time: int | None) -> list[dict]:
    quote_amount = float(config.get("quoteAmount", 10))
    frequency_sec = int(config.get("frequencySec", 7 * 24 * 3600))
    due = last_trade_time is None or candle["time"] - last_trade_time >= frequency_sec
    if not due:
        return []
    return [{"side": "buy", "type": "market", "quoteAmount": quote_amount}]
