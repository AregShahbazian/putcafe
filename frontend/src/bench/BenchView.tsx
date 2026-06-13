import { useEffect, useMemo, useState } from "react"
import { benchApi, type AlgoSummary, type MarketAgg, type SessionRow } from "./api"
import { Histogram, HBars } from "./charts"

/** Benchmark dashboard (pc-benchmark-runner). Read-only: every view is a query
 * over the bot's bench endpoints. Lands on the algo leaderboard, drills into an
 * algo's per-market bars + per-window return distribution, then a market's
 * sessions. No writes. */
export default function BenchView({ onBack }: { onBack: () => void }) {
  const [algos, setAlgos] = useState<AlgoSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AlgoSummary | null>(null)
  const [markets, setMarkets] = useState<MarketAgg[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [market, setMarket] = useState<string | null>(null)

  useEffect(() => {
    benchApi.algos().then((a) => {
      setAlgos(a)
      if (a.length) setSelected(a[0])
    }).catch((e) => setError(String(e.message ?? e)))
  }, [])

  useEffect(() => {
    if (!selected) return
    setMarket(null)
    Promise.all([benchApi.markets(selected.config_hash), benchApi.sessions(selected.config_hash)])
      .then(([m, s]) => { setMarkets(m); setSessions(s) })
      .catch((e) => setError(String(e.message ?? e)))
  }, [selected])

  const shown = useMemo(
    () => (market ? sessions.filter((s) => s.market === market) : sessions),
    [sessions, market],
  )
  const returns = useMemo(() => shown.map((s) => s.return_pct), [shown])

  if (error) return <Shell onBack={onBack}><div className="bench-error">⚠ {error}</div></Shell>
  if (!algos) return <Shell onBack={onBack}><div className="bench-muted">loading…</div></Shell>
  if (!algos.length) return <Shell onBack={onBack}><div className="bench-muted">No benchmark results yet. Run <code>start.sh &lt;algo&gt;</code>.</div></Shell>

  return (
    <Shell onBack={onBack}>
      {/* Algo leaderboard */}
      <section className="bench-card">
        <h3>Algo leaderboard <span className="bench-muted">· median return per window</span></h3>
        <table className="bench-table">
          <thead><tr><th>algo</th><th>sessions</th><th>median %</th><th>avg %</th><th>best</th><th>worst</th><th>avg win%</th><th>avg maxDD%</th><th>busts</th></tr></thead>
          <tbody>
            {algos.map((a) => (
              <tr key={a.config_hash} className={selected?.config_hash === a.config_hash ? "active" : ""}
                onClick={() => setSelected(a)} style={{ cursor: "pointer" }}>
                <td><b>{a.algo}</b></td>
                <td>{a.sessions}</td>
                <td className={a.median_return_pct >= 0 ? "pos" : "neg"}>{a.median_return_pct.toFixed(2)}</td>
                <td className={a.avg_return_pct >= 0 ? "pos" : "neg"}>{a.avg_return_pct.toFixed(2)}</td>
                <td className="pos">{a.best_return_pct.toFixed(2)}</td>
                <td className="neg">{a.worst_return_pct.toFixed(2)}</td>
                <td>{(a.avg_win_rate * 100).toFixed(1)}</td>
                <td>{a.avg_max_drawdown.toFixed(2)}</td>
                <td>{a.busts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {selected && (
        <>
          <section className="bench-card">
            <h3>
              {selected.algo} — return distribution
              <span className="bench-muted"> · {market ? market : "all markets"} · {shown.length} windows</span>
              {market && <button className="bench-chip" onClick={() => setMarket(null)}>✕ all markets</button>}
            </h3>
            <Histogram values={returns} />
            <div className="bench-stats">
              <Stat label="median" v={median(returns)} pct />
              <Stat label="mean" v={mean(returns)} pct />
              <Stat label="best" v={returns.length ? Math.max(...returns) : 0} pct />
              <Stat label="worst" v={returns.length ? Math.min(...returns) : 0} pct />
              <Stat label="% green" v={returns.length ? (returns.filter((r) => r > 0).length / returns.length) * 100 : 0} pct />
            </div>
          </section>

          <section className="bench-card">
            <h3>Per-market avg return <span className="bench-muted">· click a bar to filter the distribution</span></h3>
            <div className="bench-scroll">
              <HBars
                items={markets.map((m) => ({
                  label: `${m.exchange} ${m.market}`,
                  value: m.avg_return_pct,
                  active: market === m.market,
                }))}
                onClick={(label) => {
                  const m = markets.find((x) => `${x.exchange} ${x.market}` === label)
                  setMarket(m ? m.market : null)
                }}
              />
            </div>
          </section>
        </>
      )}
    </Shell>
  )
}

function Shell({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  return (
    <div className="bench-root">
      <header className="bench-head">
        <button className="bench-chip" onClick={onBack}>← trading</button>
        <h2>Benchmarks</h2>
      </header>
      <div className="bench-body">{children}</div>
    </div>
  )
}

function Stat({ label, v, pct }: { label: string; v: number; pct?: boolean }) {
  return (
    <div className="bench-stat">
      <span className="bench-muted">{label}</span>
      <b className={v >= 0 ? "pos" : "neg"}>{v >= 0 ? "+" : ""}{v.toFixed(2)}{pct ? "%" : ""}</b>
    </div>
  )
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
