import { useState } from "react"
import type { PivotOptions } from "../api/backend"
import type { Preset } from "../util/presets"
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

const INTERVAL_SEC: Record<string, number> = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "12h": 43200,
  "1d": 86400, "3d": 259200, "1w": 604800,
}

// A preset whose end is within ~2 candles of now may include a still-forming
// candle → its run isn't reproducible.
const endsNearNow = (interval: string, end: number) =>
  Date.now() / 1000 - end < 2 * (INTERVAL_SEC[interval] ?? 3600)

export interface PanelConfig {
  mode: "replay" | "headless"
  algo: "dca" | "pivot"
  quoteAmount: number
  frequencySec: number
  startingBalance: number
  feesEnabled: boolean
  // Pivot-breakout strategy params (used when algo === "pivot").
  tpSlRatio: number
  slCapPct: number
  positionSize: number
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
  savedCandles: SavedCandle[]
  onRemoveSaved: (index: number) => void
  onClearSaved: () => void
  pivotOptions: PivotOptions
  onPivotOptions: (patch: Partial<PivotOptions>) => void
  presets: Preset[]
  onSavePreset: (name: string) => void
  onLoadPreset: (preset: Preset) => void
  onRemovePreset: (name: string) => void
}

const fmtDate = (t?: number) =>
  t === undefined ? null : new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

const fmtUsd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 })

export default function BacktestPanel(p: Props) {
  const { snap, config } = p
  const active = snap.status !== "idle" && snap.status !== "loading"
  const running = snap.status === "playing" || snap.status === "ready" || snap.status === "paused"
  const [exporting, setExporting] = useState(false)

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

  const set = (patch: Partial<PanelConfig>) => p.onConfig({ ...config, ...patch })

  const po = p.pivotOptions
  const pivotsLocked = snap.status === "loading" || (snap.mode === "headless" && snap.status === "playing")

  const last = snap.upTo > 0 ? snap.candles[snap.upTo - 1] : null
  const s = snap.session
  const equity = s && last ? s.quoteBalance + s.baseQty * last.close : null
  const unrealized = s && last && s.avgEntry !== null ? s.baseQty * (last.close - s.avgEntry) : null
  const roi = s && equity !== null ? ((equity - s.startingBalance) / s.startingBalance) * 100 : null

  // Pivot-algo running stats, clipped to the cursor so replay doesn't spoil the result.
  const cursorT = last ? last.time : 0
  const sim = snap.pivotSim
  const pClosed = sim ? sim.trades.filter(t => t.exitTime !== null && t.exitTime <= cursorT) : []
  const pRealized = pClosed.reduce((a, t) => a + (t.pnl ?? 0), 0)
  const pWins = pClosed.filter(t => (t.pnl ?? 0) >= 0).length
  const pOpen = sim?.trades.find(t => t.entryTime <= cursorT && (t.exitTime === null || t.exitTime > cursorT))
  const pUnreal =
    pOpen && last ? (pOpen.side === "long" ? 1 : -1) * pOpen.qty * (last.close - pOpen.entryPrice) : null
  const pEquity = config.startingBalance + pRealized
  const pRoi = (pRealized / config.startingBalance) * 100

  return (
    <aside className="backtest-panel">
      <h3>Backtest</h3>

      <label className="field">
        Algorithm
        <select value={config.algo} disabled={active} onChange={e => set({ algo: e.target.value as PanelConfig["algo"] })}>
          <option value="dca">DCA</option>
          <option value="pivot">Pivot breakout</option>
        </select>
      </label>
      {config.algo === "dca" ? (
        <>
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
        </>
      ) : (
        <>
          <label className="field">
            Position size (USDT)
            <input
              type="number"
              min={1}
              value={config.positionSize}
              disabled={active}
              onChange={e => set({ positionSize: Number(e.target.value) })}
            />
          </label>
          {/* Live-tunable during a pivot replay — re-runs the sim. */}
          <label className="field">
            TP/SL ratio (e.g. 2 = TP is 2× the SL)
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={config.tpSlRatio}
              disabled={pivotsLocked}
              onChange={e => set({ tpSlRatio: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            SL cap (%) — max stop distance
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={config.slCapPct}
              disabled={pivotsLocked}
              onChange={e => set({ slCapPct: Number(e.target.value) })}
            />
          </label>
        </>
      )}
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

      {/* Live-controllable during replay — only a running headless batch locks them. */}
      <div className="pivot-options">
        <label className="field-row">
          <input
            type="checkbox"
            checked={po.enabled}
            disabled={pivotsLocked}
            onChange={e => p.onPivotOptions({ enabled: e.target.checked })}
          />
          Show pivots (swing highs/lows)
        </label>
        {po.enabled && (
          <>
            <label className="field">
              Pivot lookback (candles per side)
              <input
                type="number"
                min={1}
                value={po.lookback}
                disabled={pivotsLocked}
                onChange={e => {
                  const v = Math.floor(Number(e.target.value))
                  if (v >= 1) p.onPivotOptions({ lookback: v })
                }}
              />
            </label>
            <label className="field-row" title="Collapse consecutive same-side pivots to the strongest.">
              <input
                type="checkbox"
                checked={po.alternation}
                disabled={pivotsLocked}
                onChange={e => p.onPivotOptions({ alternation: e.target.checked })}
              />
              Enforce high/low alternation
            </label>
          </>
        )}
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
        <button
          className="tool-button"
          disabled={active || p.rangeStart === undefined || p.rangeEnd === undefined}
          onClick={() => {
            const name = window.prompt("Preset name")?.trim()
            if (name) p.onSavePreset(name)
          }}
        >
          Save as preset
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

      {sim && active && (
        <div className="results">
          <h4>Pivot results {snap.status === "finished" ? "(final)" : "(running)"}</h4>
          <dl>
            <dt>Position</dt>
            <dd>{pOpen ? `${pOpen.side} @ ${fmtUsd(pOpen.entryPrice)}` : "flat"}</dd>
            <dt>Last price</dt><dd>{last ? fmtUsd(last.close) : "—"}</dd>
            <dt>Unrealized PnL</dt>
            <dd className={pUnreal !== null && pUnreal < 0 ? "neg" : "pos"}>
              {pUnreal !== null ? fmtUsd(pUnreal) : "—"} USDT
            </dd>
            <dt>Realized PnL</dt>
            <dd className={pRealized < 0 ? "neg" : "pos"}>{fmtUsd(pRealized)} USDT</dd>
            <dt>Equity</dt><dd>{fmtUsd(pEquity)} USDT</dd>
            <dt>ROI</dt>
            <dd className={pRoi < 0 ? "neg" : "pos"}>{pRoi.toFixed(2)} %</dd>
            <dt>Closed trades</dt>
            <dd>{pClosed.length}{pClosed.length > 0 ? ` · ${pWins}W/${pClosed.length - pWins}L` : ""}</dd>
          </dl>
        </div>
      )}

      {!running && (
        <div className="sessions">
          <div className="section-head">
            <h4>Presets</h4>
          </div>
          {p.presets.length === 0 && <div className="sessions-empty">None — set up a backtest, then "Save as preset"</div>}
          {p.presets.map(preset => (
            <div key={preset.name} className="preset-row">
              <button className="preset-load" onClick={() => p.onLoadPreset(preset)}>
                <span className="preset-name">
                  {preset.name}
                  {endsNearNow(preset.interval, preset.rangeEnd) && (
                    <span className="preset-warn" title="Ends near now — the last candle may still be forming, so the run isn't reproducible."> ⚠</span>
                  )}
                </span>
                <span className="session-date">
                  {preset.market.symbol} · {preset.interval} · {preset.config.algo} ·{" "}
                  {new Date(preset.rangeStart * 1000).toLocaleDateString()}–{new Date(preset.rangeEnd * 1000).toLocaleDateString()}
                </span>
              </button>
              <button className="preset-remove" title="Remove" onClick={() => p.onRemovePreset(preset.name)}>×</button>
            </div>
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
