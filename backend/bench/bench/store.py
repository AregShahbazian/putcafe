"""Results store — one SQLite row per session (pc-benchmark-runner §3), WAL,
under /data/bench/results.db. Idempotent upsert so reruns resume; every row is
self-describing (config_json) and reproducible (config_hash + corpus_manifest_ref)."""

import os
import sqlite3

from . import config

METRIC_COLS = [
    "realized_pnl", "return_pct", "equity_final",
    "wins", "losses", "trades", "win_rate", "max_drawdown", "bust",
]

KEY_COLS = ["config_hash", "exchange", "market", "resolution",
            "range_start", "range_end"]

ALL_COLS = (KEY_COLS + ["algo", "config_json", "corpus_manifest_ref",
                        "run_id", "created_ts"] + METRIC_COLS)

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS results (
  config_hash TEXT NOT NULL,
  exchange    TEXT NOT NULL,
  market      TEXT NOT NULL,
  resolution  TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end   INTEGER NOT NULL,
  algo TEXT NOT NULL,
  config_json TEXT NOT NULL,
  corpus_manifest_ref TEXT,
  run_id TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  realized_pnl REAL, return_pct REAL, equity_final REAL,
  wins INTEGER, losses INTEGER, trades INTEGER,
  win_rate REAL, max_drawdown REAL, bust INTEGER,
  PRIMARY KEY ({", ".join(KEY_COLS)})
) WITHOUT ROWID;
"""


def open_db() -> sqlite3.Connection:
    os.makedirs(config.BENCH_DIR, exist_ok=True)
    conn = sqlite3.connect(config.RESULTS_DB, check_same_thread=False)
    # DELETE (rollback) journal, NOT WAL: the bot reads results.db from a
    # read-only mount, and a WAL reader must write the -shm sidecar → fails ro
    # ("unable to open database file"). DELETE leaves no sidecars, so ro reads
    # work. Writes are serialized by the runner's lock, so we don't need WAL.
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.executescript(SCHEMA)
    return conn


def upsert(conn: sqlite3.Connection, row: dict) -> None:
    cols = [c for c in ALL_COLS if c in row]
    conn.execute(
        f"INSERT OR REPLACE INTO results ({', '.join(cols)}) "
        f"VALUES ({', '.join('?' for _ in cols)})",
        [row[c] for c in cols])
    conn.commit()


def done_keys(conn: sqlite3.Connection, config_hashes: list[str]) -> set:
    """Already-stored session keys for the run's configs — drives resume."""
    if not config_hashes:
        return set()
    qs = ",".join("?" for _ in config_hashes)
    return set(conn.execute(
        f"SELECT {', '.join(KEY_COLS)} FROM results WHERE config_hash IN ({qs})",
        config_hashes).fetchall())


def leaderboard_by_config(conn: sqlite3.Connection, config_hashes: list[str],
                          metric: str) -> list[dict]:
    """Per-config aggregate (benchmark-map ranking): mean metric across that
    config's sessions, plus counts. Ranked best-first."""
    metric = metric if metric in METRIC_COLS else "return_pct"
    qs = ",".join("?" for _ in config_hashes)
    rows = conn.execute(
        f"SELECT config_hash, algo, MIN(config_json), COUNT(*), "
        f"AVG({metric}), AVG(return_pct), AVG(win_rate), AVG(max_drawdown), "
        f"SUM(bust) FROM results WHERE config_hash IN ({qs}) "
        f"GROUP BY config_hash ORDER BY AVG({metric}) DESC",
        config_hashes).fetchall()
    return [
        {"config_hash": h, "algo": a, "config_json": cj, "sessions": n,
         "metric": metric, "score": sc, "avg_return_pct": ar,
         "avg_win_rate": wr, "avg_max_drawdown": dd, "busts": busts}
        for h, a, cj, n, sc, ar, wr, dd, busts in rows
    ]


def leaderboard_by_market(conn: sqlite3.Connection, config_hash: str,
                          metric: str) -> list[dict]:
    """Per-(exchange,market,resolution) ranking within one config (benchmark)."""
    metric = metric if metric in METRIC_COLS else "return_pct"
    rows = conn.execute(
        f"SELECT exchange, market, resolution, COUNT(*), "
        f"AVG({metric}), AVG(return_pct), AVG(win_rate), AVG(max_drawdown) "
        f"FROM results WHERE config_hash=? "
        f"GROUP BY exchange, market, resolution ORDER BY AVG({metric}) DESC",
        (config_hash,)).fetchall()
    return [
        {"exchange": ex, "market": m, "resolution": r, "sessions": n,
         "metric": metric, "score": sc, "avg_return_pct": ar,
         "avg_win_rate": wr, "avg_max_drawdown": dd}
        for ex, m, r, n, sc, ar, wr, dd in rows
    ]


def rows_for(conn: sqlite3.Connection, config_hashes: list[str]) -> list[dict]:
    """All result rows for the given configs — backs the Parquet export."""
    if not config_hashes:
        return []
    qs = ",".join("?" for _ in config_hashes)
    cur = conn.execute(
        f"SELECT {', '.join(ALL_COLS)} FROM results WHERE config_hash IN ({qs}) "
        f"ORDER BY config_hash, exchange, market, resolution, range_start",
        config_hashes)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]
