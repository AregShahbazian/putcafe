import { useEffect, useState } from "react"
import { positions, type Session } from "../api/backend"
import type { EngineSnapshot } from "../backtest/engine"
import { fetchKlinesRange } from "../binance/api"
import { downloadJson, fileStamp } from "../util/download"
import type { SavedCandle } from "../util/savedCandles"

export type PickerField = "start" | "end" | null

const FREQUENCIES: Array<{ label: string; sec: number }> = [
  { label: "Daily", sec: 86400 },
  { label: "Every 3 days", sec: 3 * 86400 },
  { label: "Weekly", sec: 7 * 86400 },
  { label: "Every 2 weeks", sec: 14 * 86400 },
]

export interface PanelConfig {
  mode: "replay" | "headless"
  quoteAmount: number
  frequencySec: number
  startingBalance: number
  feesEnabled: boolean
}

interface Props {
  snap: EngineSnapshot
  config: PanelConfig
  onConfig: (c: PanelConfig) => void
  market: string
  interval: string
  rangeStart?: number
  rangeEnd?: number
  picking: PickerField
  onPick: (field: PickerField) => void
  onStart: () => void
  onStop: () => void
  onLoadSession: (id: string) => void
  savedCandles: SavedCandle[]
  onRemoveSaved: (index: number) => void
  onClearSaved: () => void
}

const fmtDate = (t?: number) =>
  t === undefined ? null : new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

const fmtUsd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 })

export default function BacktestPanel(p: Props) {
  const { snap, config } = p
  const active = snap.status !== "idle" && snap.status !== "loading"
  const running = snap.status === "playing" || snap.status === "ready" || snap.status === "paused"
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const refreshSessions = () =>
    positions
      .listSessions()
      .then(setSessions)
      .catch((e: unknown) => setSessionsError(e instanceof Error ? e.message : String(e)))

  useEffect(() => {
    if (snap.status !== "idle" && snap.status !== "finished") return
    void refreshSessions()
  }, [snap.status])

  const exportRange = async () => {
    if (p.rangeStart === undefined || p.rangeEnd === undefined) return
    setExporting(true)
    try {
      const candles = await fetchKlinesRange(p.market, p.interval, p.rangeStart, p.rangeEnd)
      downloadJson(
        `candles_${p.market}_${p.interval}_${fileStamp(p.rangeStart)}_${fileStamp(p.rangeEnd)}.json`,
        { market: p.market, interval: p.interval, candles },
      )
    } finally {
      setExporting(false)
    }
  }

  const clearSessions = async () => {
    const activeId = s && s.status === "active" ? s.id : undefined
    await positions.clearSessions(activeId).catch(() => {})
    void refreshSessions()
  }

  const set = (patch: Partial<PanelConfig>) => p.onConfig({ ...config, ...patch })

  const last = snap.upTo > 0 ? snap.candles[snap.upTo - 1] : null
  const s = snap.session
  const equity = s && last ? s.quoteBalance + s.baseQty * last.close : null
  const unrealized = s && last && s.avgEntry !== null ? s.baseQty * (last.close - s.avgEntry) : null
  const roi = s && equity !== null ? ((equity - s.startingBalance) / s.startingBalance) * 100 : null

  return (
    <aside className="backtest-panel">
      <h3>Backtest</h3>

      <label className="field">
        Algorithm
        <select defaultValue="dca" disabled={active}>
          <option value="dca">DCA</option>
        </select>
      </label>
      <label className="field">
        Buy amount (USDT)
        <input
          type="number"
          min={1}
          value={config.quoteAmount}
          disabled={active}
          onChange={e => set({ quoteAmount: Number(e.target.value) })}
        />
      </label>
      <label className="field">
        Frequency
        <select
          value={config.frequencySec}
          disabled={active}
          onChange={e => set({ frequencySec: Number(e.target.value) })}
        >
          {FREQUENCIES.map(f => (
            <option key={f.sec} value={f.sec}>{f.label}</option>
          ))}
        </select>
      </label>
      <label className="field">
        Starting balance (USDT)
        <input
          type="number"
          min={1}
          value={config.startingBalance}
          disabled={active}
          onChange={e => set({ startingBalance: Number(e.target.value) })}
        />
      </label>
      <label className="field-row">
        <input
          type="checkbox"
          checked={config.feesEnabled}
          disabled={active}
          onChange={e => set({ feesEnabled: e.target.checked })}
        />
        Simulate fees + slippage
      </label>
      <div className="field-row mode-row">
        {(["replay", "headless"] as const).map(m => (
          <label key={m}>
            <input
              type="radio"
              name="mode"
              checked={config.mode === m}
              disabled={active}
              onChange={() => set({ mode: m })}
            />
            {m === "replay" ? "Replay" : "Headless"}
          </label>
        ))}
      </div>

      <div className="pickers">
        <button
          className={p.picking === "start" ? "picker active" : "picker"}
          disabled={active}
          onClick={() => p.onPick(p.picking === "start" ? null : "start")}
        >
          {fmtDate(p.rangeStart) ?? "Select Start Candle"}
        </button>
        <button
          className={p.picking === "end" ? "picker active" : "picker"}
          disabled={active}
          onClick={() => p.onPick(p.picking === "end" ? null : "end")}
        >
          {fmtDate(p.rangeEnd) ?? "Select End Candle"}
        </button>
        {p.picking && <div className="picker-hint">Click a candle on the chart (Esc to cancel)</div>}
        <button
          className="tool-button"
          disabled={p.rangeStart === undefined || p.rangeEnd === undefined || exporting}
          onClick={() => void exportRange()}
        >
          {exporting ? "Exporting…" : "Export candles"}
        </button>
      </div>

      {!active ? (
        <button
          className="start-button"
          disabled={
            snap.status === "loading" ||
            p.rangeStart === undefined ||
            p.rangeEnd === undefined ||
            p.rangeEnd <= p.rangeStart
          }
          onClick={p.onStart}
        >
          {snap.status === "loading" ? "Starting…" : "Start backtest"}
        </button>
      ) : (
        <button className="stop-button-wide" onClick={p.onStop}>
          {running ? "Stop session" : "Back to live chart"}
        </button>
      )}

      {snap.mode === "headless" && snap.status === "playing" && (
        <div className="progress indeterminate">
          <div className="progress-bar" />
          <span>Running backtest…</span>
        </div>
      )}

      {snap.error && <div className="panel-error">{snap.error}</div>}

      {s && active && (
        <div className="results">
          <h4>Results {s.status === "finished" ? "(final)" : "(running)"}</h4>
          <dl>
            <dt>Balance</dt><dd>{fmtUsd(s.quoteBalance)} USDT</dd>
            <dt>Position</dt><dd>{s.baseQty.toLocaleString("en-US", { maximumFractionDigits: 8 })}</dd>
            <dt>Avg entry</dt><dd>{s.avgEntry !== null ? fmtUsd(s.avgEntry) : "—"}</dd>
            <dt>Last price</dt><dd>{last ? fmtUsd(last.close) : "—"}</dd>
            <dt>Unrealized PnL</dt>
            <dd className={unrealized !== null && unrealized < 0 ? "neg" : "pos"}>
              {unrealized !== null ? fmtUsd(unrealized) : "—"} USDT
            </dd>
            <dt>Fees paid</dt><dd>{fmtUsd(s.feesPaid)} USDT</dd>
            <dt>Equity</dt><dd>{equity !== null ? fmtUsd(equity) : "—"} USDT</dd>
            <dt>ROI</dt>
            <dd className={roi !== null && roi < 0 ? "neg" : "pos"}>
              {roi !== null ? `${roi.toFixed(2)} %` : "—"}
            </dd>
            <dt>Trades</dt><dd>{snap.trades.length}</dd>
          </dl>
        </div>
      )}

      {!running && (
        <div className="sessions">
          <div className="section-head">
            <h4>Sessions</h4>
            {sessions.length > 0 && (
              <button className="tool-button small" onClick={() => void clearSessions()}>
                Clear sessions
              </button>
            )}
          </div>
          {sessionsError && <div className="panel-error">{sessionsError}</div>}
          {sessions.length === 0 && !sessionsError && <div className="sessions-empty">None yet</div>}
          {sessions.map(item => (
            <button key={item.id} className="session-row" onClick={() => p.onLoadSession(item.id)}>
              <span>{item.market} · {item.interval} · {item.mode}</span>
              <span className="session-date">
                {new Date(item.createdAt).toLocaleDateString()} · {item.status}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="saved-candles">
        <div className="section-head">
          <h4>Saved candles</h4>
          {p.savedCandles.length > 0 && (
            <button className="tool-button small" onClick={p.onClearSaved}>Clear</button>
          )}
        </div>
        {p.savedCandles.length === 0 && <div className="sessions-empty">None — right-click a candle → "Save candle"</div>}
        {p.savedCandles.map((sc, i) => (
          <div key={`${sc.market}-${sc.interval}-${sc.candle.time}`} className="saved-row">
            <span>
              {sc.market} · {sc.interval} ·{" "}
              {new Date(sc.candle.time * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}{" "}
              · C {sc.candle.close}
            </span>
            <button title="Remove" onClick={() => p.onRemoveSaved(i)}>×</button>
          </div>
        ))}
        {p.savedCandles.length > 0 && (
          <button
            className="tool-button"
            onClick={() =>
              downloadJson(`saved-candles_${fileStamp(Math.floor(Date.now() / 1000))}.json`, p.savedCandles)
            }
          >
            Export saved candles
          </button>
        )}
      </div>
    </aside>
  )
}
