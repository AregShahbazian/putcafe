"""Read-only reader over the candle corpus shards (/data/<exchange>.db, written
by the scraper — pc-candle-store). Shards keep epoch-ms; we return epoch-s in
the bot's Candle shape. Never writes."""

import os
import sqlite3

from . import config


def shard_path(exchange: str) -> str:
    return os.path.join(config.DATA_DIR, f"{exchange}.db")


def _connect(exchange: str) -> sqlite3.Connection | None:
    path = shard_path(exchange)
    if not os.path.exists(path):
        return None
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def list_exchanges() -> list[str]:
    if not os.path.isdir(config.DATA_DIR):
        return []
    return sorted(
        f[:-3] for f in os.listdir(config.DATA_DIR)
        if f.endswith(".db") and os.path.isfile(os.path.join(config.DATA_DIR, f)))


def list_markets(exchange: str, resolution: str) -> list[str]:
    conn = _connect(exchange)
    if conn is None:
        return []
    try:
        return [m for (m,) in conn.execute(
            "SELECT DISTINCT market FROM candles WHERE resolution=? ORDER BY market",
            (resolution,))]
    finally:
        conn.close()


def bounds(exchange: str, market: str, resolution: str) -> tuple[int, int] | None:
    """(earliest, latest) candle open-times in epoch-s, or None if absent."""
    conn = _connect(exchange)
    if conn is None:
        return None
    try:
        row = conn.execute(
            "SELECT MIN(ts), MAX(ts) FROM candles WHERE market=? AND resolution=?",
            (market, resolution)).fetchone()
    finally:
        conn.close()
    if not row or row[0] is None:
        return None
    return row[0] // 1000, row[1] // 1000


def slice(exchange: str, market: str, resolution: str,
          start_s: int, end_s: int) -> list[dict]:
    """Candles in [start_s, end_s] inclusive, bot Candle shape. Empty if the
    shard/range is absent (the caller records it as a gap — never live-fetch)."""
    conn = _connect(exchange)
    if conn is None:
        return []
    try:
        rows = conn.execute(
            "SELECT ts, open, high, low, close, volume FROM candles"
            " WHERE market=? AND resolution=? AND ts>=? AND ts<=? ORDER BY ts",
            (market, resolution, start_s * 1000, end_s * 1000)).fetchall()
    finally:
        conn.close()
    return [
        {"time": ts // 1000, "open": o, "high": h, "low": lo,
         "close": c, "volume": v}
        for ts, o, h, lo, c, v in rows
    ]
