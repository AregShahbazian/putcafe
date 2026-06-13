"""Corpus overview — fast. For each /data/<exchange>.db shard: file size on
disk, market count, and the 1m date span. No COUNT(*) over the big table — the
span comes from indexed MIN/MAX seeks per (market,'1m'), which are PK-prefix
boundary lookups, so this returns in well under a second.

  python -m scraper.overview [--log]
"""

import argparse
import glob
import os
import sqlite3
import time

from . import config

# Loose index skip-scan: ~one seek per distinct market instead of walking the
# whole clustered PK (market,resolution,ts).
DISTINCT_MARKETS = """
WITH RECURSIVE m(x) AS (
  SELECT MIN(market) FROM candles
  UNION ALL
  SELECT (SELECT MIN(market) FROM candles WHERE market > x) FROM m WHERE x IS NOT NULL
)
SELECT x FROM m WHERE x IS NOT NULL
"""


def _iso(ts_ms):
    return time.strftime("%Y-%m-%d", time.gmtime(ts_ms / 1000)) if ts_ms else "-"


def collect() -> list[dict]:
    rows = []
    for path in sorted(glob.glob(os.path.join(config.DATA_DIR, "*.db"))):
        ex = os.path.splitext(os.path.basename(path))[0]
        size_mb = os.path.getsize(path) / 1_048_576
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            markets = [m for (m,) in conn.execute(DISTINCT_MARKETS)]
            # Per-resolution date span across the shard's markets. MIN and MAX as
            # separate scalar subqueries — one aggregate each so SQLite uses the
            # index seek (a single MIN(ts),MAX(ts) query would scan every row).
            spans = {res: [None, None] for res in config.RESOLUTIONS}
            for m in markets:
                for res in config.RESOLUTIONS:
                    lo, hi = conn.execute(
                        "SELECT (SELECT MIN(ts) FROM candles WHERE market=? AND resolution=?),"
                        "       (SELECT MAX(ts) FROM candles WHERE market=? AND resolution=?)",
                        (m, res, m, res)).fetchone()
                    if lo is not None:
                        s = spans[res]
                        s[0] = lo if s[0] is None else min(s[0], lo)
                        s[1] = hi if s[1] is None else max(s[1], hi)
        finally:
            conn.close()
        rows.append({"exchange": ex, "markets": len(markets),
                     "size_mb": size_mb, "spans": spans})
    return rows


def _size(mb: float) -> str:
    return f"{mb / 1024:,.1f} GB" if mb >= 1024 else f"{mb:,.0f} MB"


def render(data: list[dict]) -> str:
    data = sorted(data, key=lambda x: -x["size_mb"])
    total_mb = sum(d["size_mb"] for d in data)
    total_mk = sum(d["markets"] for d in data)

    def span(s):
        return f"{_iso(s[0])} → {_iso(s[1])}" if s[0] else "—"

    rows = []
    for d in data:
        rows.append((
            d["exchange"],
            str(d["markets"]),
            _size(d["size_mb"]),
            *(span(d["spans"][res]) for res in config.RESOLUTIONS),
        ))
    headers = ("EXCHANGE", "MARKETS", "SIZE",
               *(f"{res} SPAN" for res in config.RESOLUTIONS))
    n = len(headers)
    w = [max(len(headers[i]), *(len(r[i]) for r in rows)) for i in range(n)]

    def line(c):
        cells = [f"{c[0]:<{w[0]}}", f"{c[1]:>{w[1]}}", f"{c[2]:>{w[2]}}"]
        cells += [f"{c[3 + i]:<{w[3 + i]}}" for i in range(len(config.RESOLUTIONS))]
        return "  " + "   ".join(cells)

    rule = "  " + "─" * (sum(w) + 3 * (n - 1))
    out = [
        f"  Candle corpus — {time.strftime('%Y-%m-%d %H:%M', time.gmtime())} UTC",
        f"  {len(data)} exchanges · {total_mk} markets · {_size(total_mb)} on disk",
        "",
        line(headers),
        rule,
    ]
    out += [line(r) for r in rows]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", action="store_true",
                    help="also append a timestamped snapshot under /data/overviews/")
    args = ap.parse_args()
    body = render(collect())
    print(body)
    if args.log:
        d = os.path.join(config.DATA_DIR, "overviews")
        os.makedirs(d, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        with open(os.path.join(d, f"{stamp}.md"), "w") as f:
            f.write(body + "\n")
        print(f"\nlogged: /data/overviews/{stamp}.md")


if __name__ == "__main__":
    main()
