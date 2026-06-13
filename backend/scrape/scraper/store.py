"""Per-exchange SQLite shard: /data/<exchange>.db, WAL, one writer each.
Rows keyed (market, resolution, ts-ms); upserts make re-scrapes idempotent."""

import os
import sqlite3

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS candles (
  market     TEXT    NOT NULL,
  resolution TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  open  REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
  close REAL NOT NULL, volume REAL NOT NULL,
  PRIMARY KEY (market, resolution, ts)
) WITHOUT ROWID;
"""


def shard_path(exchange: str) -> str:
    return os.path.join(config.DATA_DIR, f"{exchange}.db")


def open_shard(exchange: str) -> sqlite3.Connection:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    # check_same_thread=False: asyncio.to_thread hops pool threads, but each
    # shard has exactly one worker task, so access is still serialized.
    conn = sqlite3.connect(shard_path(exchange), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    return conn


def upsert(conn: sqlite3.Connection, market: str, resolution: str, rows: list) -> int:
    """rows: ccxt ohlcv lists [ts, o, h, l, c, v]. Returns rows written."""
    conn.executemany(
        "INSERT OR REPLACE INTO candles VALUES (?,?,?,?,?,?,?,?)",
        [(market, resolution, r[0], r[1], r[2], r[3], r[4], r[5]) for r in rows],
    )
    conn.commit()
    return len(rows)


def watermark(conn: sqlite3.Connection, market: str, resolution: str) -> int | None:
    """Last stored ts (ms) — resume point."""
    row = conn.execute(
        "SELECT MAX(ts) FROM candles WHERE market=? AND resolution=?",
        (market, resolution),
    ).fetchone()
    return row[0]


def coverage(conn: sqlite3.Connection) -> list[dict]:
    """Per (market, resolution): count + span. Drives manifest and status."""
    return [
        {"market": m, "resolution": r, "count": n, "first_ts": lo, "last_ts": hi}
        for m, r, n, lo, hi in conn.execute(
            "SELECT market, resolution, COUNT(*), MIN(ts), MAX(ts)"
            " FROM candles GROUP BY market, resolution ORDER BY market, resolution"
        )
    ]
