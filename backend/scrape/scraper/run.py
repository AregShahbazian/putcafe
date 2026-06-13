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


SHRINK_TRIES = 3  # widen→narrow attempts before deciding the data is just absent


def _depthy(e) -> bool:
    """True when the error clearly means 'history doesn't go back that far'
    (vs. 'this request's window is too wide') — lets us jump instead of shrink."""
    m = str(e).lower()
    return "too long ago" in m or "points ago" in m or "too old" in m


def _record(ex_state, msg: str):
    ex_state["errors_total"] += 1
    if len(ex_state["errors"]) < config.MAX_ERRORS_LOGGED:
        ex_state["errors"].append(msg)


async def _oldest_available(exchange, symbol, resolution, lo, hi, tf, stop):
    """`lo` rejected as too-far-back, `hi` known good. Binary-search the oldest
    `since` that still returns data — salvages depth-capped exchanges (e.g. gate
    serves only the most recent N candles). Returns the ts (ms) or None."""
    good = None
    while hi - lo > config.PAGE_LIMIT * tf and not stop.is_set():
        mid = (lo + hi) // 2
        try:
            r = await exchange.fetch_ohlcv(symbol, resolution, since=mid, limit=1)
        except Exception:
            lo = mid
            continue
        if r:
            good, hi = r[0][0], mid
        else:
            lo = mid
    return good


async def scrape_market(exchange, conn, ex_state, symbol, resolution, stop, span_memo):
    """Forward-page [since, until] windows. `until` keeps each request inside an
    exchange's per-request span cap; on a `range` error we shrink the window
    (remembered per resolution), on a `depth` error we jump forward to the
    oldest reachable candle. Only closed bars are stored."""
    tf = config.RESOLUTION_MS[resolution]
    now = int(time.time() * 1000)
    end_cap = now - tf
    floor = now - config.YEARS * 365 * 86_400_000
    wm = await asyncio.to_thread(store.watermark, conn, symbol, resolution)
    since = max(wm + tf, floor) if wm else floor
    span = span_memo.get(resolution, config.PAGE_LIMIT * tf)
    shrinks, jumped = 0, False

    while since < end_cap and not stop.is_set():
        until = min(since + span, now)
        try:
            rows = await exchange.fetch_ohlcv(
                symbol, resolution, since=since, limit=config.PAGE_LIMIT,
                params={"until": until})
        except Exception as e:
            # First try narrowing the window a few times (handles per-request
            # span caps); if that doesn't help, or the error says the data is
            # simply too old, jump forward to the oldest candle still served.
            if not _depthy(e) and shrinks < SHRINK_TRIES and span > tf * 4:
                span = max(tf * 4, span // 4)
                span_memo[resolution] = span
                shrinks += 1
                continue
            if not jumped:
                jumped = True
                nxt = await _oldest_available(exchange, symbol, resolution,
                                              since, end_cap, tf, stop)
                if nxt and nxt > since:
                    ex_state["gaps"] += 1
                    since = nxt
                    continue
            _record(ex_state, f"{symbol} {resolution}: {e}")
            return
        shrinks = 0
        rows = [r for r in rows if r[0] is not None and r[0] <= end_cap]
        if not rows:
            since = until + tf
            continue
        ex_state["candles"] += await asyncio.to_thread(
            store.upsert, conn, symbol, resolution, rows)
        last = rows[-1][0]
        since = last + tf if last + tf > since else until + tf


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
        span_memo: dict = {}
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
                                            symbol, resolution, stop, span_memo)
                    except Exception as e:
                        _record(ex_state, f"{symbol} {resolution}: {e}")
                ex_state["markets_done"] += 1
            ex_state["current"] = None
            ex_state["state"] = "stopped" if stop.is_set() else "done"
        finally:
            conn.close()
    except Exception as e:
        if ex_id in st.exchanges:
            st.exchanges[ex_id]["state"] = "failed"
            _record(st.exchanges[ex_id], str(e))
        else:
            st.init_exchange(ex_id, [])
            st.exchanges[ex_id].update(state="failed", errors=[str(e)], errors_total=1)
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
