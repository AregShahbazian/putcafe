"""Benchmark orchestrator (pc-benchmark-runner §2). Expands a spec into concrete
sessions, replays each through the engine over HTTP (`bot:/api/bot/futures/run`)
against stored candles, and upserts one results row per session.

Sessions are enumerated up front (deterministically — random windows are drawn
here, once, so reruns reproduce), then executed under a bounded semaphore.
Already-stored sessions are skipped (resume); empty/absent slices are gaps, not
fatal. SIGTERM/SIGINT stop cleanly and still write the manifest."""

import argparse
import asyncio
import json
import os
import random
import signal
import time
import urllib.error
import urllib.request

from . import candles, config, manifest, metrics, spec as spec_mod, status as status_mod, store


def corpus_manifest_ref() -> str | None:
    """Most-recent scrape manifest run-id (provenance for what we replayed)."""
    d = config.CORPUS_MANIFEST_DIR
    if not os.path.isdir(d):
        return None
    ids = sorted(f[:-5] for f in os.listdir(d) if f.endswith(".json"))
    return ids[-1] if ids else None


def _markets_for(sel: dict, exchange: str, resolution: str) -> list[str]:
    if sel.get("markets"):
        return list(sel["markets"])
    bases = set(sel.get("bases", []))
    quotes = set(sel.get("quotes", []))
    out = []
    for m in candles.list_markets(exchange, resolution):
        if "/" not in m:
            continue
        base, quote = m.split("/", 1)
        if (not bases or base in bases) and (not quotes or quote in quotes):
            out.append(m)
    return out


def _windows(rng: dict, exchange: str, market: str, resolution: str,
             rand: random.Random) -> list[tuple[int, int]]:
    """Resolve a market's session ranges per the spec's range mode. Random draws
    consume `rand` here (enumeration time) so the resolved absolute ranges are
    stable across reruns."""
    mode = rng.get("mode", "full")
    if mode == "window":
        return [(int(rng["start"]), int(rng["end"]))]
    b = candles.bounds(exchange, market, resolution)
    if b is None:
        return []
    earliest, latest = b
    if mode == "full":
        return [(earliest, latest)]
    if mode == "random":
        from .randoms import roll_random_range
        interval = config.RESOLUTION_S[resolution]
        n = int(rng.get("n", 10))
        out = []
        for _ in range(n):
            try:
                out.append(roll_random_range(
                    earliest, latest, interval,
                    int(rng.get("minBars", 200)), int(rng.get("maxBars", 1000)),
                    rand.random))
            except ValueError:
                break  # not enough history for this market
        return out
    raise ValueError(f"unknown range mode: {mode}")


def build_sessions(sp: spec_mod.Spec) -> list[dict]:
    """Deterministic cartesian: configs × exchanges × markets × resolutions ×
    range windows. One dict per session, ready to execute."""
    sel = sp.selector
    resolutions = sel.get("resolutions", ["1h"])
    exchanges = sel.get("exchanges", ["*"])
    if exchanges == ["*"] or "*" in exchanges:
        exchanges = candles.list_exchanges()
    rand = random.Random(sp.range.get("seed", 0))
    sessions = []
    for cfg in sp.configs():
        chash = spec_mod.config_hash(cfg)
        cjson = json.dumps(cfg, sort_keys=True, separators=(",", ":"))
        for exchange in exchanges:
            for resolution in resolutions:
                for market in _markets_for(sel, exchange, resolution):
                    for start, end in _windows(sp.range, exchange, market,
                                               resolution, rand):
                        sessions.append({
                            "config": cfg, "config_hash": chash,
                            "config_json": cjson, "algo": cfg["algo"],
                            "exchange": exchange, "market": market,
                            "resolution": resolution,
                            "range_start": start, "range_end": end,
                        })
    return sessions


def _run_engine(body: dict) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{config.BOT_URL}/api/bot/futures/run", data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=config.RUN_TIMEOUT_S) as resp:
        return json.loads(resp.read())


async def _run_session(s: dict, st: status_mod.Status, manifest_ref, run_id,
                       sem: asyncio.Semaphore, stop: asyncio.Event,
                       conn) -> None:
    async with sem:
        if stop.is_set():
            return
        st.current = f"{s['exchange']} {s['market']} {s['resolution']}"
        rows = await asyncio.to_thread(
            candles.slice, s["exchange"], s["market"], s["resolution"],
            s["range_start"], s["range_end"])
        if not rows:
            st.gaps += 1
            return
        body = {"candles": rows, "algo": s["algo"],
                "params": s["config"]["params"], "pivots": s["config"]["pivots"]}
        try:
            snapshot = await asyncio.to_thread(_run_engine, body)
        except (urllib.error.URLError, OSError, ValueError) as e:
            st.record_error(f"{st.current}: {e}")
            return
        sb = float(s["config"]["params"].get("startingBalance", 1000.0))
        row = {
            **{k: s[k] for k in ("config_hash", "exchange", "market",
                                 "resolution", "range_start", "range_end",
                                 "algo", "config_json")},
            "corpus_manifest_ref": manifest_ref, "run_id": run_id,
            "created_ts": int(time.time()), **metrics.compute(snapshot, sb),
        }
        await asyncio.to_thread(store.upsert, conn, row)
        st.done += 1


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", default=os.environ.get("BENCH_SPEC", "algo-compare"),
                    help="spec name under specs/ (or path); "
                         "defaults to $BENCH_SPEC then 'algo-compare'")
    ap.add_argument("--dry-run", action="store_true",
                    help="enumerate + count sessions, no engine calls")
    ap.add_argument("--force", action="store_true",
                    help="run even if sessions exceed SESSION_CAP")
    args = ap.parse_args()

    sp = spec_mod.load(args.spec)
    sessions = build_sessions(sp)
    n_configs = len(sp.configs())
    print(f"spec {sp.name}: {n_configs} config(s), {len(sessions)} sessions",
          flush=True)

    if not sessions:
        print("no sessions — empty corpus or selector matched nothing", flush=True)
        return
    if len(sessions) > config.SESSION_CAP and not args.force:
        raise SystemExit(
            f"{len(sessions)} sessions exceeds SESSION_CAP={config.SESSION_CAP}; "
            f"narrow the spec or pass --force")
    if args.dry_run:
        for s in sessions[:10]:
            print(f"  {s['config_hash']} {s['exchange']} {s['market']} "
                  f"{s['resolution']} [{s['range_start']},{s['range_end']}]",
                  flush=True)
        if len(sessions) > 10:
            print(f"  … +{len(sessions) - 10} more", flush=True)
        return

    run_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    manifest_ref = corpus_manifest_ref()
    conn = store.open_db()
    done = store.done_keys(conn, [spec_mod.config_hash(c) for c in sp.configs()])
    todo = [s for s in sessions
            if (s["config_hash"], s["exchange"], s["market"], s["resolution"],
                s["range_start"], s["range_end"]) not in done]
    print(f"run {run_id}: {len(todo)} to run, {len(sessions) - len(todo)} "
          f"already stored (resume)", flush=True)

    st = status_mod.Status(run_id, sp.name, len(sessions), n_configs)
    st.done = len(sessions) - len(todo)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    sem = asyncio.Semaphore(config.CONCURRENCY)
    writer = asyncio.create_task(status_mod.writer(st, stop))
    await asyncio.gather(*(
        _run_session(s, st, manifest_ref, run_id, sem, stop, conn) for s in todo))

    st.state = "stopped" if stop.is_set() else "done"
    st.current = None
    stop.set()
    await writer
    conn.close()
    path = manifest.write(sp, sessions, st, manifest_ref)
    print(f"manifest: {path}.json / .md\nrun {run_id}: {st.state} "
          f"({st.done} done, {st.gaps} gaps, {st.errors_total} errors)", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
