"""Corpus overview — scans every /data/<exchange>.db shard and reports what
candle data we actually have: per exchange and resolution, the market count,
candle count, and date span. Prints to stdout and (with --log) appends a
timestamped Markdown snapshot under /data/overviews/ as a durable record.

  python -m scraper.overview [--log]
"""

import argparse
import glob
import os
import sqlite3
import time

from . import config


def _iso(ts_ms):
    return time.strftime("%Y-%m-%d", time.gmtime(ts_ms / 1000)) if ts_ms else "-"


def _fmt(n: int) -> str:
    return f"{n:,}"


def collect() -> dict:
    """{exchange: {"markets": int, "candles": int, "by_res": {res: (mkts, candles, first, last)}}}"""
    out = {}
    for path in sorted(glob.glob(os.path.join(config.DATA_DIR, "*.db"))):
        ex = os.path.splitext(os.path.basename(path))[0]
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            rows = conn.execute(
                "SELECT resolution, COUNT(DISTINCT market), COUNT(*),"
                " MIN(ts), MAX(ts) FROM candles GROUP BY resolution"
            ).fetchall()
            markets = conn.execute(
                "SELECT COUNT(DISTINCT market) FROM candles").fetchone()[0]
            total = conn.execute("SELECT COUNT(*) FROM candles").fetchone()[0]
        finally:
            conn.close()
        out[ex] = {
            "markets": markets, "candles": total,
            "by_res": {r[0]: (r[1], r[2], r[3], r[4]) for r in rows},
        }
    return out


def render(data: dict) -> str:
    resolutions = config.RESOLUTIONS
    g_markets = sum(d["markets"] for d in data.values())
    g_candles = sum(d["candles"] for d in data.values())
    lines = [
        f"# Candle corpus overview — {time.strftime('%Y-%m-%d %H:%M', time.gmtime())} UTC",
        "",
        f"- **{len(data)} exchanges**, {g_markets} market-shards, "
        f"**{_fmt(g_candles)} candles**",
        f"- resolutions: {'/'.join(resolutions)}; filters: top {config.TOP_N}/exchange, "
        f"bases {'/'.join(sorted(config.BASES))}, last {config.YEARS}y",
        "",
        "| exchange | markets | candles | "
        + " | ".join(f"{r} (cdl · span)" for r in resolutions) + " |",
        "|---|---|---|" + "---|" * len(resolutions),
    ]
    for ex, d in sorted(data.items(), key=lambda kv: -kv[1]["candles"]):
        cells = []
        for r in resolutions:
            v = d["by_res"].get(r)
            if not v:
                cells.append("—")
            else:
                _, cdl, lo, hi = v
                cells.append(f"{_fmt(cdl)} · {_iso(lo)}→{_iso(hi)}")
        lines.append(
            f"| {ex} | {d['markets']} | {_fmt(d['candles'])} | "
            + " | ".join(cells) + " |"
        )
    return "\n".join(lines)


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
