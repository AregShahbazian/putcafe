import { useEffect, useMemo, useState } from "react"
import { benchApi, configLabel, type AlgoSummary, type MarketAgg, type SessionRow, type Compare } from "./api"
import { Histogram, HBars, BoxPlot } from "./charts"

/** Benchmark dashboard (pc-benchmark-runner). Read-only: every view is a query
 * over the bot's bench endpoints. Two modes: per-algo (leaderboard → drill into
 * distribution + per-market bars) and compare (box-plots + winner heatmap across
 * all algos on the shared windows). No writes. */
export default function BenchView({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<"algos" | "compare">("algos")
  const [algos, setAlgos] = useState<AlgoSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AlgoSummary | null>(null)
  const [markets, setMarkets] = useState<MarketAgg[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [market, setMarket] = useState<string | null>(null)
  const [compare, setCompare] = useState<Compare | null>(null)

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

  useEffect(() => {
    if (mode === "compare" && !compare) {
      benchApi.compare().then(setCompare).catch((e) => setError(String(e.message ?? e)))
    }
  }, [mode, compare])

  const shown = useMemo(
    () => (market ? sessions.filter((s) => s.market === market) : sessions),
    [sessions, market],
  )
  const returns = useMemo(() => shown.map((s) => s.return_pct), [shown])

  const tabs = (
    <div className="bench-tabs">
      <button className={mode === "algos" ? "active" : ""} onClick={() => setMode("algos")}>Per-algo</button>
      <button className={mode === "compare" ? "active" : ""} onClick={() => setMode("compare")}>Compare algos</button>
    </div>
  )

  if (error) return <Shell onBack={onBack} tabs={tabs}><div className="bench-error">⚠ {error}</div></Shell>
  if (!algos) return <Shell onBack={onBack} tabs={tabs}><div className="bench-muted">loading…</div></Shell>
  if (!algos.length) return <Shell onBack={onBack} tabs={tabs}><div className="bench-muted">No benchmark results yet. Run <code>start.sh &lt;algo&gt;</code>.</div></Shell>

  if (mode === "compare") {
    return <Shell onBack={onBack} tabs={tabs}>{compare ? <CompareView c={compare} /> : <div className="bench-muted">loading…</div>}</Shell>
  }

  return (
    <Shell onBack={onBack} tabs={tabs}>
      {/* Algo leaderboard */}
      <section className="bench-card">
        <h3>Algo leaderboard <span className="bench-muted">· median return per window</span></h3>
        <table className="bench-table">
          <thead><tr><th>algo</th><th>sessions</th><th>median %</th><th>avg %</th><th>best</th><th>worst</th><th>avg win%</th><th>avg maxDD%</th><th>busts</th></tr></thead>
          <tbody>
            {algos.map((a) => (
              <tr key={a.config_hash} className={selected?.config_hash === a.config_hash ? "active" : ""}
                onClick={() => setSelected(a)} style={{ cursor: "pointer" }}>
                <td><b>{configLabel(a.algo, a.config_json)}</b></td>
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

/** Cross-config comparison on the shared windows. Columns are config_hashes
 * (so a benchmark-map sweep's configs are distinct), labeled by their knobs. */
function CompareView({ c }: { c: Compare }) {
  const order = c.algos.map((a) => a.config_hash) // median-sorted
  const label = useMemo(() => {
    const m: Record<string, string> = {}
    for (const a of c.algos) m[a.config_hash] = configLabel(a.algo, a.config_json)
    return m
  }, [c])
  // best config per market (for highlight)
  const best = useMemo(() => {
    const m: Record<string, string> = {}
    for (const mkt of c.markets) {
      let bh = order[0], bv = -Infinity
      for (const h of order) {
        const v = c.matrix[h]?.[mkt]
        if (v != null && v > bv) { bv = v; bh = h }
      }
      m[mkt] = bh
    }
    return m
  }, [c, order])

  return (
    <>
      <section className="bench-card">
        <h3>Return distribution <span className="bench-muted">· box = p25–p75, line = median, whiskers = min–max · identical windows</span></h3>
        <BoxPlot items={c.algos.map((a) => ({ algo: label[a.config_hash], min: a.min, p25: a.p25, median: a.median, p75: a.p75, max: a.max }))} />
      </section>

      <section className="bench-card">
        <h3>Per-market winner heatmap <span className="bench-muted">· avg return per config; ★ = best on that market</span></h3>
        <div className="bench-scroll">
          <table className="bench-heat">
            <thead>
              <tr><th>market</th>{order.map((h) => <th key={h} title={label[h]}>{label[h]}</th>)}</tr>
            </thead>
            <tbody>
              {c.markets.map((mkt) => (
                <tr key={mkt}>
                  <td className="bench-heat-label">{mkt}</td>
                  {order.map((h) => {
                    const v = c.matrix[h]?.[mkt]
                    return (
                      <td key={h} style={{ background: cellColor(v) }}
                        className={best[mkt] === h ? "win" : ""}>
                        {v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`}
                        {best[mkt] === h ? " ★" : ""}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

function Shell({ children, onBack, tabs }: { children: React.ReactNode; onBack: () => void; tabs?: React.ReactNode }) {
  return (
    <div className="bench-root">
      <header className="bench-head">
        <button className="bench-chip" onClick={onBack}>← trading</button>
        <h2>Benchmarks</h2>
        {tabs}
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

function cellColor(v: number | undefined): string {
  if (v == null) return "transparent"
  const c = Math.max(-2, Math.min(2, v)) / 2 // -1..1
  return c >= 0 ? `rgba(63,185,80,${0.1 + 0.55 * c})` : `rgba(248,81,73,${0.1 + 0.55 * -c})`
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
