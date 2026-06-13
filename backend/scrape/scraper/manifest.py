"""Run manifest — the reproducibility / training-provenance record.
Written at the end of every run (completed or stopped): JSON for machines,
.md for humans, both under /data/manifests/."""

import json
import os
import time

import ccxt

from . import config, store


def _iso(ts_ms):
    if ts_ms is None:
        return None
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(ts_ms / 1000))


def write(status) -> str:
    os.makedirs(config.MANIFEST_DIR, exist_ok=True)
    snap = status.snapshot()
    cov = {}
    for ex in snap["exchanges"]:
        try:
            conn = store.open_shard(ex)
            cov[ex] = store.coverage(conn)
            conn.close()
        except Exception as e:
            cov[ex] = [{"error": str(e)}]

    doc = {
        "run_id": snap["run_id"],
        "state": snap["state"],
        "started": snap["started"],
        "finished": time.time(),
        "ccxt_version": ccxt.__version__,
        "config": {
            "bases": sorted(config.BASES), "quotes": sorted(config.QUOTES),
            "top_n": config.TOP_N, "years": config.YEARS,
            "resolutions": snap["resolutions"],
        },
        "exchanges": snap["exchanges"],
        "coverage": cov,
    }
    base = os.path.join(config.MANIFEST_DIR, snap["run_id"])
    with open(base + ".json", "w") as f:
        json.dump(doc, f, indent=1)

    lines = [
        f"# Scrape run `{snap['run_id']}` — {snap['state']}",
        "",
        f"- started {_iso(snap['started'] * 1000)} UTC, "
        f"finished {_iso(doc['finished'] * 1000)} UTC",
        f"- ccxt {ccxt.__version__}; filters: top {config.TOP_N}/exchange, "
        f"bases {'/'.join(sorted(config.BASES))}, last {config.YEARS}y, "
        f"resolutions {'/'.join(snap['resolutions'])}",
        "",
        "| exchange | markets | candles | gaps | errors |",
        "|---|---|---|---|---|",
    ]
    for ex, st in snap["exchanges"].items():
        lines.append(
            f"| {ex} | {st['markets_done']}/{len(st['markets'])} "
            f"| {st['candles']} | {st['gaps']} | {st.get('errors_total', len(st['errors']))} |"
        )
    lines += ["", "## Coverage", ""]
    for ex, rows in cov.items():
        lines.append(f"### {ex}")
        lines.append("")
        lines.append("| market | res | candles | first | last |")
        lines.append("|---|---|---|---|---|")
        for r in rows:
            if "error" in r:
                lines.append(f"| (shard error: {r['error']}) | | | | |")
                continue
            lines.append(
                f"| {r['market']} | {r['resolution']} | {r['count']} "
                f"| {_iso(r['first_ts'])} | {_iso(r['last_ts'])} |"
            )
        lines.append("")
    errs = [(ex, e) for ex, st in snap["exchanges"].items() for e in st["errors"]]
    if errs:
        lines += ["## Errors", ""]
        lines += [f"- **{ex}**: {e}" for ex, e in errs]
        lines.append("")
    with open(base + ".md", "w") as f:
        f.write("\n".join(lines))
    return base
