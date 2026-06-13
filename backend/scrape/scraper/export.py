"""Parquet export for ML pipelines — dumps a slice of a shard without touching
the canonical store.

  python -m scraper.export <exchange> <market> <resolution> [start_iso end_iso]
"""

import argparse
import os
import sqlite3
import time

import polars as pl

from . import config, store


def parse_ms(iso: str) -> int:
    return int(time.mktime(time.strptime(iso, "%Y-%m-%d")) * 1000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("exchange")
    ap.add_argument("market")
    ap.add_argument("resolution")
    ap.add_argument("start", nargs="?", help="YYYY-MM-DD (UTC)")
    ap.add_argument("end", nargs="?", help="YYYY-MM-DD (UTC)")
    args = ap.parse_args()

    path = store.shard_path(args.exchange)
    if not os.path.exists(path):
        raise SystemExit(f"no shard for exchange: {args.exchange}")

    q = ("SELECT ts, open, high, low, close, volume FROM candles"
         " WHERE market=? AND resolution=?")
    params: list = [args.market, args.resolution]
    if args.start:
        q += " AND ts>=?"
        params.append(parse_ms(args.start))
    if args.end:
        q += " AND ts<?"
        params.append(parse_ms(args.end))
    q += " ORDER BY ts"

    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    rows = conn.execute(q, params).fetchall()
    conn.close()
    if not rows:
        raise SystemExit("no candles match — not in store")

    df = pl.DataFrame(
        rows, schema=["ts", "open", "high", "low", "close", "volume"],
        orient="row")
    os.makedirs(config.EXPORT_DIR, exist_ok=True)
    name = f"{args.exchange}_{args.market.replace('/', '-')}_{args.resolution}.parquet"
    out = os.path.join(config.EXPORT_DIR, name)
    df.write_parquet(out)
    print(f"{out}: {len(df)} candles")


if __name__ == "__main__":
    main()
