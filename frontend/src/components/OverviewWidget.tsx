import { useEffect, useState } from "react"
import { positions, type PivotOrder, type PivotTrade, type Session } from "../api/backend"
import type { EngineSnapshot } from "../backtest/engine"
import { ordersAt, type OrderAt } from "../util/orders"

type Tab = "positions" | "orders" | "sessions"
type OrderFilter = "open" | "closed"

interface Props {
  snap: EngineSnapshot
  market: string
  baseAsset: string
  onLoadSession: (id: string) => void
}

const fmtPrice = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 })
const fmtQty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 })
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)} %`
const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })

// Trading-terminal-style order labels: the conditional legs carry their % from entry.
export function orderTypeLabel(o: PivotOrder): string {
  if (o.role === "tp") return `Take profit (${o.pct !== null ? fmtPct(o.pct) : "limit"})`
  if (o.role === "sl") return `Stop loss (${o.pct !== null ? fmtPct(o.pct) : "stop"})`
  if (o.role === "liq") return "Liquidation"
  if (o.type === "stop_market") return "Stop market"
  return "Market"
}

const STATUS_LABEL: Record<OrderAt["status"], string> = {
  open: "Open",
  filled: "Filled",
  cancelled: "Cancelled",
}

export default function OverviewWidget(p: Props) {
  const { snap } = p
  const [tab, setTab] = useState<Tab>("positions")
  const [filter, setFilter] = useState<OrderFilter>("open")
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsError, setSessionsError] = useState<string | null>(null)

  const refreshSessions = () =>
    positions
      .listSessions()
      .then(setSessions)
      .catch((e: unknown) => setSessionsError(e instanceof Error ? e.message : String(e)))

  useEffect(() => {
    if (snap.status !== "idle" && snap.status !== "finished") return
    void refreshSessions()
  }, [snap.status])

  const clearSessions = async () => {
    const activeId = snap.session && snap.session.status === "active" ? snap.session.id : undefined
    await positions.clearSessions(activeId).catch(() => {})
    void refreshSessions()
  }

  const last = snap.upTo > 0 ? snap.candles[snap.upTo - 1] : null
  const cursorT = last ? last.time : 0

  // Open position sides at the cursor — hedge-mode, so long and/or short. Each
  // is a trade row spanning the cursor (no lookahead; step-back re-reveals).
  const sim = snap.sim
  const openSides: PivotTrade[] = sim
    ? sim.trades.filter(t => t.entryTime <= cursorT && (t.exitTime === null || t.exitTime > cursorT))
    : []

  const orders: OrderAt[] = sim ? ordersAt(sim.orders ?? [], cursorT) : []
  const filtered = orders.filter(o => (filter === "open" ? o.status === "open" : o.status !== "open"))
  const openCount = orders.filter(o => o.status === "open").length

  const sideCls = (side: string) => (side === "buy" || side === "long" ? "pos" : "neg")
  const pnlCls = (n: number) => (n < 0 ? "neg" : "pos")

  const positionRow = (pos: PivotTrade) => {
    if (!last) return null
    const dir = pos.side === "long" ? 1 : -1
    const pnl = dir * pos.qty * (last.close - pos.entryPrice)
    const pct = dir * ((last.close - pos.entryPrice) / pos.entryPrice) * 100
    const lev = pos.leverage > 1 ? `×${pos.leverage}` : ""
    return (
      <tr key={pos.side + pos.entryTime}>
        <td>{fmtDate(pos.entryTime)}</td>
        <td>{p.market}</td>
        <td className={sideCls(pos.side)}>{pos.side === "long" ? "Long" : "Short"} {lev}</td>
        <td>{fmtQty(pos.qty)} {p.baseAsset}</td>
        <td>{fmtPrice(pos.entryPrice)}</td>
        <td>{fmtPrice(last.close)}</td>
        <td className="neg">{pos.slPrice !== null ? fmtPrice(pos.slPrice) : "—"}</td>
        <td className="pos">{pos.tpPrice !== null ? fmtPrice(pos.tpPrice) : "—"}</td>
        <td className={pnlCls(pnl)}>{fmtPrice(pnl)}</td>
        <td className={pnlCls(pct)}>{fmtPct(pct)}</td>
      </tr>
    )
  }

  return (
    <section className="overview-widget">
      <div className="ow-tabs">
        {(["positions", "orders", "sessions"] as const).map(t => (
          <button key={t} className={tab === t ? "ow-tab selected" : "ow-tab"} onClick={() => setTab(t)}>
            {t === "positions" ? "Positions" : t === "orders" ? `Orders${openCount > 0 ? ` (${openCount})` : ""}` : "Sessions"}
          </button>
        ))}
        {tab === "orders" && (
          <div className="ow-filter">
            {(["open", "closed"] as const).map(f => (
              <button key={f} className={filter === f ? "ow-tab selected" : "ow-tab"} onClick={() => setFilter(f)}>
                {f === "open" ? "Open" : "Closed"}
              </button>
            ))}
          </div>
        )}
        {tab === "sessions" && sessions.length > 0 && (
          <div className="ow-filter">
            <button className="tool-button small" onClick={() => void clearSessions()}>Clear sessions</button>
          </div>
        )}
      </div>
      <div className="ow-body">
        {tab === "positions" && (
          <table className="ow-table">
            <thead>
              <tr>
                <th>Time</th><th>Market</th><th>Side</th><th>Size</th><th>Entry</th>
                <th>Mark</th><th>SL</th><th>TP</th><th>PnL</th><th>PnL %</th>
              </tr>
            </thead>
            <tbody>
              {openSides.length > 0
                ? openSides.map(positionRow)
                : <tr><td className="ow-empty" colSpan={10}>No open position</td></tr>}
            </tbody>
          </table>
        )}
        {tab === "orders" && (
          <table className="ow-table">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Side</th><th>Price</th><th>Amount</th><th>Status</th></tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td className="ow-empty" colSpan={6}>No {filter} orders</td></tr>
              )}
              {filtered.map(({ order: o, status }) => (
                <tr key={o.id}>
                  <td>{fmtDate(status === "filled" && o.filledAt !== null ? o.filledAt : o.createdAt)}</td>
                  <td>{orderTypeLabel(o)}</td>
                  <td className={sideCls(o.side)}>{o.side === "buy" ? "Buy" : "Sell"}</td>
                  <td className={sideCls(o.side)}>
                    {fmtPrice(status === "filled" && o.fillPrice !== null ? o.fillPrice : o.price)}
                  </td>
                  <td>{fmtQty(o.qty)} {p.baseAsset}</td>
                  <td className={status === "filled" ? "pos" : status === "cancelled" ? "ow-muted" : ""}>
                    {STATUS_LABEL[status]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "sessions" && (
          <>
            {sessionsError && <div className="panel-error">{sessionsError}</div>}
            <table className="ow-table">
              <thead>
                <tr><th>Created</th><th>Market</th><th>Interval</th><th>Mode</th><th>Status</th></tr>
              </thead>
              <tbody>
                {sessions.length === 0 && !sessionsError && (
                  <tr><td className="ow-empty" colSpan={5}>No sessions yet</td></tr>
                )}
                {sessions.map(item => (
                  <tr key={item.id} className="ow-clickable" onClick={() => p.onLoadSession(item.id)}>
                    <td>{new Date(item.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
                    <td>{item.market}</td>
                    <td>{item.interval}</td>
                    <td>{item.mode}</td>
                    <td>{item.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  )
}
