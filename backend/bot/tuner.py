"""Per-algo parameter tuner / profitability harness (futures-engine port).

Fetches real Binance klines for several symbols, splits each into non-overlapping
windows, and for every indicator algo sweeps a parameter grid, scoring each combo
across all windows by *consistency* (median per-window ROI gated by % profitable
windows, discounted if too few trades). Prints a ranking and writes the best
params per algo to tuned_defaults.json.

Runs the algos directly on the FuturesEngine (`app.algos.run`) — pure stdlib +
the app modules, no server. Usage:  python tuner.py [--quick]
"""

from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.request
from pathlib import Path

from app import algos

BINANCE = "https://api.binance.com/api/v3/klines"
SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"]
INTERVAL = "1h"
TOTAL_CANDLES = 6000
WINDOW = 1000
QUICK = "--quick" in sys.argv
if QUICK:
    SYMBOLS = ["BTCUSDT", "ETHUSDT"]
    TOTAL_CANDLES = 3000


def fetch(symbol, interval, limit):
    out: list[dict] = []
    end = None
    while len(out) < limit:
        n = min(1000, limit - len(out))
        url = f"{BINANCE}?symbol={symbol}&interval={interval}&limit={n}"
        if end is not None:
            url += f"&endTime={end}"
        with urllib.request.urlopen(url, timeout=30) as r:
            raw = json.loads(r.read())
        if not raw:
            break
        batch = [
            {"time": k[0] // 1000, "open": float(k[1]), "high": float(k[2]),
             "low": float(k[3]), "close": float(k[4]), "volume": float(k[5])}
            for k in raw
        ]
        out = batch + out
        end = raw[0][0] - 1
        time.sleep(0.15)
    return out[-limit:]


class P:
    leverage = 1
    feesEnabled = True
    startingBalance = 1000.0
    frequencySec = 604800

    def __init__(self, tpSlRatio, slCapPct, algoParams):
        self.tpSlRatio = tpSlRatio
        self.slCapPct = slCapPct
        self.quoteAmount = 100.0
        self.algoParams = algoParams


class PO:
    enabled = False
    lookback = 3
    alternation = True


BRACKETS = [(r, sl) for r in (1.5, 2.0, 3.0) for sl in (2.0, 4.0, 6.0)]
if QUICK:
    BRACKETS = [(2.0, 4.0), (3.0, 4.0)]

GRIDS = {
    "ma_cross": [{"fast": f, "slow": s, "maType": "ema"} for f in (10, 20, 50) for s in (50, 100, 200) if f < s],
    "rsi_revert": [{"period": p, "oversold": o, "overbought": 100 - o} for p in (7, 14) for o in (20, 25, 30)],
    "bollinger": [{"period": p, "mult": m} for p in (20, 30) for m in (2.0, 2.5, 3.0)],
    "donchian": [{"period": p} for p in (20, 30, 55)],
    "macd": [{"fast": f, "slow": s, "signal": 9} for (f, s) in ((12, 26), (8, 21), (5, 35))],
}
if QUICK:
    GRIDS = {k: v[:2] for k, v in GRIDS.items()}

INDICATOR_ALGOS = ["ma_cross", "rsi_revert", "bollinger", "donchian", "macd"]


def windows(candles):
    return [candles[i:i + WINDOW] for i in range(0, len(candles) - WINDOW + 1, WINDOW)]


def score_combo(algo, ap, ratio, sl, all_windows):
    rois, trades_total = [], 0
    for w in all_windows:
        p = P(ratio, sl, ap)
        snap = algos.run(algo, w, p, PO)
        roi = (snap["equity"] - p.startingBalance) / p.startingBalance * 100
        rois.append(roi)
        trades_total += sum(1 for t in snap["trades"] if t["pnl"] is not None)
    median = statistics.median(rois)
    pct_green = 100 * sum(1 for x in rois if x > 0) / len(rois)
    worst = min(rois)
    trade_factor = min(1.0, trades_total / (3 * len(all_windows)))
    score = median * (pct_green / 100) * trade_factor
    return {"algoParams": ap, "tpSlRatio": ratio, "slCapPct": sl,
            "medianRoi": round(median, 2), "pctGreen": round(pct_green, 1),
            "worstRoi": round(worst, 2), "trades": trades_total, "score": round(score, 3)}


def main():
    print(f"Fetching {SYMBOLS} {INTERVAL} x{TOTAL_CANDLES} …")
    all_windows = []
    for sym in SYMBOLS:
        c = fetch(sym, INTERVAL, TOTAL_CANDLES)
        ws = windows(c)
        print(f"  {sym}: {len(c)} candles -> {len(ws)} windows")
        all_windows += ws
    print(f"Total windows: {len(all_windows)}\n")

    results = {}
    for algo in INDICATOR_ALGOS:
        combos = []
        for ap in GRIDS[algo]:
            for ratio, sl in BRACKETS:
                combos.append(score_combo(algo, ap, ratio, sl, all_windows))
        combos.sort(key=lambda x: x["score"], reverse=True)
        results[algo] = {"best": combos[0], "top": combos[:3]}
        print(f"== {algo} ==")
        for c in combos[:3]:
            print(f"   score={c['score']:7.2f}  medianRoi={c['medianRoi']:6.2f}%  green={c['pctGreen']:5.1f}%  "
                  f"worst={c['worstRoi']:7.2f}%  trades={c['trades']:4d}  {c['algoParams']} sl={c['slCapPct']} r={c['tpSlRatio']}")
        print()

    ranking = sorted(results.items(), key=lambda kv: kv[1]["best"]["score"], reverse=True)
    print("=== ALGO RANKING (by best consistency score) ===")
    for i, (algo, r) in enumerate(ranking, 1):
        b = r["best"]
        print(f" {i}. {algo:12s} score={b['score']:7.2f}  medianRoi={b['medianRoi']:6.2f}%  "
              f"green={b['pctGreen']:5.1f}%  worst={b['worstRoi']:7.2f}%")

    out = Path(__file__).parent / "tuned_defaults.json"
    out.write_text(json.dumps({"meta": {"symbols": SYMBOLS, "interval": INTERVAL,
                   "windows": len(all_windows), "windowSize": WINDOW},
                   "ranking": [a for a, _ in ranking],
                   "tuned": {a: r["best"] for a, r in results.items()}}, indent=2))
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
