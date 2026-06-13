"""Compact, self-refreshing scrape dashboard (the `monitor` view). Reads
/data/status.json and prints a terminal-fit table of fetched vs estimated-total
candles per exchange. `--watch` clears + repaints every few seconds.

  python -m scraper.render [--watch]

'Estimated total' is len(markets) x sum(2y / timeframe) over the run's
resolutions — a ceiling; depth-capped exchanges legitimately finish below it."""

import argparse
import json
import sys
import time

from . import config

REFRESH_S = 3


def _fmt(n: int) -> str:
    for unit, div in (("M", 1_000_000), ("k", 1_000)):
        if n >= div:
            return f"{n / div:.1f}{unit}"
    return str(n)


def _expected_per_market(resolutions) -> int:
    span = config.YEARS * 365 * 86_400_000
    return sum(span // config.RESOLUTION_MS[r] for r in resolutions)


def render(snap: dict) -> str:
    res = snap.get("resolutions", config.RESOLUTIONS)
    exp_pm = _expected_per_market(res)
    exs = snap["exchanges"]
    total_c = sum(s["candles"] for s in exs.values())
    total_exp = sum(len(s["markets"]) * exp_pm for s in exs.values()) or 1
    done = sum(1 for s in exs.values()
               if s["state"] in ("done", "failed", "stopped", "dry-run"))
    el = int(time.time() - snap["started"])
    pct = 100 * total_c / total_exp

    out = [
        f"run {snap['run_id']}  {snap['state'].upper()}  "
        f"{done}/{len(exs)} exch  "
        f"{_fmt(total_c)}/{_fmt(total_exp)} candles ({pct:.1f}%)  "
        f"{el // 60}m{el % 60:02d}s",
        f"{'EXCHANGE':<12}{'MKT':>7}{'CANDLES':>10}{'ERR':>6}  {'STATE':<8}CURRENT",
    ]
    for ex, s in exs.items():
        mk = f"{s['markets_done']}/{len(s['markets'])}"
        out.append(
            f"{ex:<12}{mk:>7}{_fmt(s['candles']):>10}"
            f"{s.get('errors_total', len(s['errors'])):>6}  "
            f"{s['state']:<8}{s.get('current') or '-'}"
        )
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--watch", action="store_true")
    args = ap.parse_args()
    while True:
        try:
            with open(config.STATUS_FILE) as f:
                snap = json.load(f)
            body = render(snap)
            running = snap.get("state") == "running"
        except (FileNotFoundError, json.JSONDecodeError):
            body, running = "(no run yet — no status.json)", False
        if not args.watch:
            print(body)
            return
        sys.stdout.write("\033[2J\033[H" + body + "\n")
        sys.stdout.flush()
        if not running:
            return
        time.sleep(REFRESH_S)


if __name__ == "__main__":
    main()
