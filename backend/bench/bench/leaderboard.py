"""Leaderboard — ranked aggregation over results.db (pc-benchmark-runner §4).
A live query, not a separate store. For a benchmark-map it ranks configs against
each other; for a single benchmark it ranks markets within the config.

  python -m bench.leaderboard <spec> [--metric return_pct]
"""

import argparse
import json
import os

from . import config, spec as spec_mod, store

LEADERBOARD_DIR = os.path.join(config.BENCH_DIR, "leaderboards")


def build(sp: spec_mod.Spec, metric: str) -> dict:
    conn = store.open_db()
    try:
        hashes = [spec_mod.config_hash(c) for c in sp.configs()]
        by_config = store.leaderboard_by_config(conn, hashes, metric)
        per_config_markets = {
            h: store.leaderboard_by_market(conn, h, metric)
            for h in hashes
        }
    finally:
        conn.close()
    return {"spec": sp.name, "metric": metric, "is_map": sp.is_map(),
            "configs": by_config, "markets": per_config_markets}


def render_md(doc: dict) -> str:
    lines = [f"# Leaderboard — `{doc['spec']}` (by {doc['metric']})", ""]
    if doc["is_map"]:
        lines += ["## Configs (best first)", "",
                  f"| rank | config_hash | sessions | {doc['metric']} | "
                  f"avg return% | avg win% | avg maxDD% | busts |",
                  "|---|---|---|---|---|---|---|---|"]
        for i, c in enumerate(doc["configs"], 1):
            lines.append(
                f"| {i} | `{c['config_hash']}` | {c['sessions']} | "
                f"{_n(c['score'])} | {_n(c['avg_return_pct'])} | "
                f"{_pct(c['avg_win_rate'])} | {_n(c['avg_max_drawdown'])} | "
                f"{c['busts']} |")
        lines.append("")
    for c in doc["configs"]:
        h = c["config_hash"]
        mk = doc["markets"].get(h, [])
        if not mk:
            continue
        lines += [f"## `{h}` — {c.get('algo', '')} per-market", "",
                  f"| exchange | market | res | sessions | {doc['metric']} | "
                  f"avg return% | avg win% | avg maxDD% |",
                  "|---|---|---|---|---|---|---|---|"]
        for m in mk:
            lines.append(
                f"| {m['exchange']} | {m['market']} | {m['resolution']} | "
                f"{m['sessions']} | {_n(m['score'])} | {_n(m['avg_return_pct'])} "
                f"| {_pct(m['avg_win_rate'])} | {_n(m['avg_max_drawdown'])} |")
        lines.append("")
    return "\n".join(lines)


def _n(x):
    return f"{x:.2f}" if isinstance(x, (int, float)) else "—"


def _pct(x):
    return f"{x * 100:.1f}" if isinstance(x, (int, float)) else "—"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--metric", default="return_pct")
    args = ap.parse_args()
    sp = spec_mod.load(args.spec)
    doc = build(sp, args.metric)
    os.makedirs(LEADERBOARD_DIR, exist_ok=True)
    base = os.path.join(LEADERBOARD_DIR, f"{sp.name}-{args.metric}")
    with open(base + ".json", "w") as f:
        json.dump(doc, f, indent=1)
    md = render_md(doc)
    with open(base + ".md", "w") as f:
        f.write(md)
    print(md)


if __name__ == "__main__":
    main()
