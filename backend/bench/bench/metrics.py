"""Snapshot → core metrics (pc-benchmark-runner §3, core-only). The engine
returns raw trades, so richer metrics (sharpe, profit factor) stay derivable
from stored rows later without re-running."""


def compute(snapshot: dict, starting_balance: float) -> dict:
    realized = float(snapshot.get("realizedPnl", 0.0))
    wins = int(snapshot.get("wins", 0))
    losses = int(snapshot.get("losses", 0))
    closed = wins + losses
    sb = starting_balance or 1.0
    return {
        "realized_pnl": realized,
        "return_pct": realized / sb * 100.0,
        "equity_final": float(snapshot.get("equity", sb)),
        "wins": wins,
        "losses": losses,
        "trades": closed,
        "win_rate": (wins / closed) if closed else 0.0,
        "max_drawdown": _max_drawdown(snapshot.get("trades", []), starting_balance),
        "bust": 1 if snapshot.get("bust") else 0,
    }


def _max_drawdown(trades: list, starting_balance: float) -> float:
    """Peak-to-trough drawdown (%) over the realized-equity curve, walked in
    trade-close order. Open trades (pnl=None) are skipped. v1 is trade-level
    (not per-candle) — enough to rank, refinable later."""
    equity = starting_balance
    peak = starting_balance
    worst = 0.0
    for tr in trades:
        pnl = tr.get("pnl")
        if pnl is None:
            continue
        equity += pnl
        if equity > peak:
            peak = equity
        if peak > 0:
            dd = (peak - equity) / peak * 100.0
            if dd > worst:
                worst = dd
    return worst
