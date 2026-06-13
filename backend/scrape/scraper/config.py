"""Scrape scope — the corpus filters from the PRD (pc-candle-store §3).
Widen by editing here; nothing else hardcodes thresholds."""

import os

# bitmart + coinbase dropped: stingy rate limits / small page sizes made a 2y
# 1m backfill impractically slow vs. the other 16.
EXCHANGES = [
    "binance", "bingx", "bitvavo", "bybit",
    "cryptocom", "gate", "hitbtc", "htx", "hyperliquid", "kraken",
    "kucoin", "mexc", "okx", "poloniex", "toobit", "woo",
]

BASES = {"BTC", "ETH", "SOL", "BNB", "XRP"}
QUOTES = {"USDT", "USDC", "USD", "EUR", "FDUSD", "DAI", "TUSD"}

TOP_N = 20            # per exchange, by 30d quote volume
YEARS = 2             # rolling history window
RESOLUTIONS = ["1m", "1h", "1d"]

RESOLUTION_MS = {"1m": 60_000, "1h": 3_600_000, "1d": 86_400_000}

PAGE_LIMIT = 1000     # fetch_ohlcv page size; ccxt clamps per exchange
MAX_ERRORS_LOGGED = 25  # per exchange; the rest are counted, not stored

DATA_DIR = os.environ.get("DATA_DIR", "/data")
MANIFEST_DIR = os.path.join(DATA_DIR, "manifests")
EXPORT_DIR = os.path.join(DATA_DIR, "exports")
STATUS_FILE = os.path.join(DATA_DIR, "status.json")
