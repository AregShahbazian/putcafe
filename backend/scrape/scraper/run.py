"""Scrape orchestrator. One asyncio worker per exchange (own SQLite shard, so
writers never contend); markets × resolutions sequential within a worker; ccxt
async clients throttle themselves. Resume is implicit: paging starts at the
shard watermark. SIGTERM/SIGINT stop cleanly and still write the manifest."""

import argparse
import asyncio
import signal
import time

import ccxt.async_support as ccxt_async

from . import config, manifest, markets, status as status_mod, store


def page_span_ms(resolution: str) -> int:
    return config.PAGE_LIMIT * config.RESOLUTION_MS[resolution]


async def scrape_market(exchange, conn, ex_state, symbol, resolution, stop):
    tf_ms = config.RESOLUTION_MS[resolution]
    now_ms = int(time.time() * 1000)
    floor_ms = now_ms - config.YEARS * 365 * 86_400_000
    wm = await asyncio.to_thread(store.watermark, conn, symbol, resolution)
    since = max(wm + tf_ms, floor_ms) if wm else floor_ms

    while since < now_ms - tf_ms and not stop.is_set():
        rows = await exchange.fetch_ohlcv(symbol, resolution, since=since,
                                          limit=config.PAGE_LIMIT)
        # Drop the still-open bar — only closed candles are reproducible.
        rows = [r for r in rows if r[0] is not None and r[0] <= now_ms - tf_ms]
        if not rows:
            ex_state["gaps"] += 1
            since += page_span_ms(resolution)
            continue
        ex_state["candles"] += await asyncio.to_thread(
            store.upsert, conn, symbol, resolution, rows)
        last = rows[-1][0]
        if last + tf_ms <= since:  # no forward progress — bail out of the pair
            ex_state["errors"].append(f"{symbol} {resolution}: stuck at ts {last}")
            return
        since = last + tf_ms


async def scrape_exchange(ex_id, st, stop, resolutions, dry_run):
    exchange = None
    try:
        exchange = getattr(ccxt_async, ex_id)({"enableRateLimit": True})
        await exchange.load_markets()
        selected = await markets.select(exchange)
        st.init_exchange(ex_id, selected)
        ex_state = st.exchanges[ex_id]
        if dry_run:
            print(f"{ex_id}: {len(selected)} markets -> {selected}", flush=True)
            ex_state["state"] = "dry-run"
            return
        conn = await asyncio.to_thread(store.open_shard, ex_id)
        try:
            for symbol in selected:
                if stop.is_set():
                    break
                ex_state["current"] = symbol
                for resolution in resolutions:
                    if stop.is_set():
                        break
                    try:
                        await scrape_market(exchange, conn, ex_state,
                                            symbol, resolution, stop)
                    except Exception as e:
                        ex_state["errors"].append(f"{symbol} {resolution}: {e}")
                ex_state["markets_done"] += 1
            ex_state["current"] = None
            ex_state["state"] = "stopped" if stop.is_set() else "done"
        finally:
            conn.close()
    except Exception as e:
        if ex_id in st.exchanges:
            st.exchanges[ex_id]["state"] = "failed"
            st.exchanges[ex_id]["errors"].append(str(e))
        else:
            st.init_exchange(ex_id, [])
            st.exchanges[ex_id].update(state="failed", errors=[str(e)])
    finally:
        if exchange is not None:
            await exchange.close()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exchanges", help="csv subset of config.EXCHANGES")
    ap.add_argument("--resolutions", help="csv subset of config.RESOLUTIONS")
    ap.add_argument("--dry-run", action="store_true",
                    help="select + print markets only, no fetch/writes")
    args = ap.parse_args()

    exchanges = args.exchanges.split(",") if args.exchanges else config.EXCHANGES
    resolutions = (args.resolutions.split(",") if args.resolutions
                   else config.RESOLUTIONS)

    run_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    st = status_mod.Status(run_id, resolutions)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    writer = None if args.dry_run else asyncio.create_task(
        status_mod.writer(st, stop))
    await asyncio.gather(*(
        scrape_exchange(ex, st, stop, resolutions, args.dry_run)
        for ex in exchanges))

    st.state = "stopped" if stop.is_set() else "done"
    stop.set()
    if writer:
        await writer
        path = await asyncio.to_thread(manifest.write, st)
        print(f"manifest: {path}.json / .md", flush=True)
    print(f"run {run_id}: {st.state}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
