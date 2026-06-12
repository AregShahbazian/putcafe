import { useEffect, useRef, useState } from "react"
import { fetchMarkets, type Market } from "./binance/api"
import { BacktestEngine, type EngineSnapshot } from "./backtest/engine"
import type { SessionConfig } from "./api/backend"
import ChartView, { type SessionView } from "./chart/ChartView"
import MarketSelector from "./components/MarketSelector"
import TimeframeSelector, { type Interval } from "./components/TimeframeSelector"
import BacktestPanel, { type PanelConfig, type PickerField } from "./components/BacktestPanel"
import PlaybackControls from "./components/PlaybackControls"
import ChartContextMenu, { type ContextMenuState } from "./components/ChartContextMenu"
import { useSavedCandles } from "./util/savedCandles"
import { usePivotOptions } from "./util/pivotOptions"
import { usePresets, type Preset } from "./util/presets"
import type { PivotOptions } from "./api/backend"
import {
  bridgeSnapshot,
  installBridge,
  registerAppHandle,
  type SessionOverrides,
  type UiState,
} from "./debug/bridge"

const DEFAULT_MARKET: Market = { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT" }

const DEFAULT_CONFIG: PanelConfig = {
  mode: "headless",
  algo: "dca",
  quoteAmount: 10,
  frequencySec: 7 * 86400,
  startingBalance: 1000,
  feesEnabled: true,
  tpSlRatio: 2,
  slCapPct: 4,
  positionSize: 100,
}

export default function App() {
  const [markets, setMarkets] = useState<Market[]>([])
  const [marketsError, setMarketsError] = useState<string | null>(null)
  const [market, setMarket] = useState<Market>(DEFAULT_MARKET)
  const [interval, setInterval] = useState<Interval>("1h")

  const [panelOpen, setPanelOpen] = useState(true)
  const [config, setConfig] = useState<PanelConfig>(DEFAULT_CONFIG)
  const [rangeStart, setRangeStart] = useState<number | undefined>()
  const [rangeEnd, setRangeEnd] = useState<number | undefined>()
  const [picking, setPicking] = useState<PickerField>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const savedCandles = useSavedCandles()
  const pivotOptions = usePivotOptions()
  const presets = usePresets()

  const engineRef = useRef<BacktestEngine | null>(null)
  const [snap, setSnap] = useState<EngineSnapshot | null>(null)
  // The bridge taps every engine snapshot (events + waiters) before React sees it.
  if (engineRef.current === null)
    engineRef.current = new BacktestEngine(sn => {
      bridgeSnapshot(sn)
      setSnap(sn)
    })
  const engine = engineRef.current
  const s: EngineSnapshot = snap ?? engine.snapshot

  // Debug: `pc()` in the browser console dumps the live state for inspection.
  // `pc(time)` filters trades to those touching that candle time (sec or ms).
  useEffect(() => {
    ;(window as unknown as { pc: (t?: number) => unknown }).pc = (t?: number) => {
      const sim = engine.snapshot.pivotSim
      const norm = t === undefined ? undefined : t > 1e12 ? Math.floor(t / 1000) : t
      const trades =
        sim && norm !== undefined
          ? sim.trades.filter(tr => tr.entryTime === norm || tr.exitTime === norm)
          : sim?.trades
      const dump = {
        market: market.symbol,
        interval,
        config,
        pivotOptions: pivotOptions.options,
        status: engine.snapshot.status,
        session: engine.snapshot.session,
        sim: sim && { equity: sim.equity, wins: sim.wins, losses: sim.losses, realizedPnl: sim.realizedPnl },
        trades,
      }
      // eslint-disable-next-line no-console
      console.log(dump)
      return dump
    }
  }, [engine, market.symbol, interval, config, pivotOptions.options])

  useEffect(() => {
    fetchMarkets()
      .then(setMarkets)
      .catch((e: unknown) => setMarketsError(e instanceof Error ? e.message : String(e)))
  }, [])

  // Changing market/timeframe exits an active session (mirrors trading-terminal's replay).
  const prevKeyRef = useRef(`${market.symbol}-${interval}`)
  useEffect(() => {
    const key = `${market.symbol}-${interval}`
    if (key !== prevKeyRef.current) {
      prevKeyRef.current = key
      if (engine.snapshot.status !== "idle") void engine.stop()
      setRangeStart(undefined)
      setRangeEnd(undefined)
      setPicking(null)
    }
  }, [market.symbol, interval, engine])

  // The engine mirrors the persisted pivot options; mid-replay changes go to the
  // bot as a live control (it recomputes and returns updated pivots, or — for the
  // pivot algo — re-runs the whole strategy sim).
  useEffect(() => {
    void engine.setPivotOptions(pivotOptions.options)
  }, [pivotOptions.options, engine])

  // Pivot-strategy params: live control during a pivot replay (re-runs the sim).
  useEffect(() => {
    void engine.setPivotParams({
      tpSlRatio: config.tpSlRatio,
      slCapPct: config.slCapPct,
      quoteAmount: config.positionSize,
    })
  }, [config.tpSlRatio, config.slCapPct, config.positionSize, engine])

  // Escape cancels candle picking.
  useEffect(() => {
    if (!picking) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicking(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [picking])

  const startSession = (mode: PanelConfig["mode"], start: number, end: number) => {
    const sessionConfig: SessionConfig = {
      market: market.symbol,
      interval,
      startTime: start,
      endTime: end,
      mode,
      algo: config.algo,
      algoConfig: { quoteAmount: config.quoteAmount, frequencySec: config.frequencySec },
      pivotParams:
        config.algo === "pivot"
          ? { tpSlRatio: config.tpSlRatio, slCapPct: config.slCapPct, quoteAmount: config.positionSize }
          : undefined,
      startingBalance: config.startingBalance,
      feesEnabled: config.feesEnabled,
    }
    void engine.start(sessionConfig)
  }

  const savePreset = (name: string) => {
    if (rangeStart === undefined || rangeEnd === undefined) return
    presets.save({ name, market, interval, rangeStart, rangeEnd, config, pivotOptions: pivotOptions.options })
  }

  const loadPreset = (p: Preset) => {
    if (engine.snapshot.status !== "idle") void engine.stop()
    // Pre-sync the market/interval key so the change effect below doesn't wipe
    // the range we're about to set from the preset.
    prevKeyRef.current = `${p.market.symbol}-${p.interval}`
    setMarket(p.market)
    setInterval(p.interval)
    setConfig(p.config)
    setRangeStart(p.rangeStart)
    setRangeEnd(p.rangeEnd)
    pivotOptions.set(p.pivotOptions)
    setPicking(null)
    setPanelOpen(true)
  }

  // Console bridge (`window.pc`): the handle's getters/actions read these refs,
  // rebuilt every render, so registration happens once but never goes stale.
  const uiRef = useRef<UiState>(undefined as unknown as UiState)
  uiRef.current = {
    market,
    interval,
    config,
    pivotOptions: pivotOptions.options,
    rangeStart,
    rangeEnd,
    presets: presets.presets.map(p => p.name),
  }

  // Bridge-driven start: builds the SessionConfig from merged current-state +
  // overrides itself (no stale setState reads) and syncs the visible UI to it.
  const startFromBridge = (o: SessionOverrides) => {
    const symbol = o.market ?? market.symbol
    const iv = o.interval ?? interval
    const cfg: PanelConfig = {
      mode: o.mode ?? config.mode,
      algo: o.algo ?? config.algo,
      quoteAmount: o.quoteAmount ?? config.quoteAmount,
      frequencySec: o.frequencySec ?? config.frequencySec,
      startingBalance: o.startingBalance ?? config.startingBalance,
      feesEnabled: o.feesEnabled ?? config.feesEnabled,
      tpSlRatio: o.tpSlRatio ?? config.tpSlRatio,
      slCapPct: o.slCapPct ?? config.slCapPct,
      positionSize: o.positionSize ?? config.positionSize,
    }
    // Pre-sync the market/interval key (same trick as loadPreset) so the
    // change effect doesn't stop the session we're about to start.
    prevKeyRef.current = `${symbol}-${iv}`
    if (symbol !== market.symbol)
      setMarket(
        markets.find(m => m.symbol === symbol) ?? {
          symbol,
          baseAsset: symbol.replace(/USDT$/, ""),
          quoteAsset: "USDT",
        },
      )
    if (iv !== interval) setInterval(iv)
    setConfig(cfg)
    setRangeStart(o.start)
    setRangeEnd(o.end)
    setPicking(null)
    setPanelOpen(true)
    void engine.start({
      market: symbol,
      interval: iv,
      startTime: o.start!,
      endTime: o.end!,
      mode: cfg.mode,
      algo: cfg.algo,
      algoConfig: { quoteAmount: cfg.quoteAmount, frequencySec: cfg.frequencySec },
      pivotParams:
        cfg.algo === "pivot"
          ? { tpSlRatio: cfg.tpSlRatio, slCapPct: cfg.slCapPct, quoteAmount: cfg.positionSize }
          : undefined,
      startingBalance: cfg.startingBalance,
      feesEnabled: cfg.feesEnabled,
    })
  }

  const loadPresetByName = (name: string) => {
    const p = presets.presets.find(x => x.name === name)
    if (!p)
      throw new Error(
        `preset "${name}" not found (have: ${presets.presets.map(x => x.name).join(", ") || "none"})`,
      )
    loadPreset(p)
  }

  const bridgeRef = useRef({ startFromBridge, loadPresetByName })
  bridgeRef.current = { startFromBridge, loadPresetByName }

  useEffect(() => {
    installBridge(engine)
    return registerAppHandle({
      getUi: () => uiRef.current,
      startSession: o => bridgeRef.current.startFromBridge(o),
      stopSession: () => engine.stop(),
      loadPreset: name => bridgeRef.current.loadPresetByName(name),
      loadSession: id => void engine.loadSession(id),
    })
  }, [engine])

  const onChartClick = (time: number) => {
    if (!picking) return
    if (picking === "start") setRangeStart(time)
    else setRangeEnd(time)
    setPicking(null)
  }

  const replayActive =
    s.mode === "replay" && ["ready", "playing", "paused", "finished"].includes(s.status)
  // Pivot sims have no positions-backend session, so they're carried by pivotSim.
  const hasRun = s.session !== null || s.pivotSim !== null
  const showSession: SessionView | null =
    hasRun && (replayActive || (s.mode === "headless" && s.status === "finished"))
      ? {
          candles: s.candles,
          preCandles: s.preCandles,
          upTo: s.upTo,
          trades: s.trades,
          pivots: s.pivots,
          pivotSim: s.pivotSim,
          fitRange: s.mode === "headless" && s.status === "finished",
        }
      : null

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">putcafe</span>
        <MarketSelector
          markets={markets}
          selected={market}
          error={marketsError}
          onSelect={setMarket}
        />
        <TimeframeSelector selected={interval} onSelect={setInterval} />
        <button
          className={panelOpen ? "header-button active" : "header-button"}
          onClick={() => setPanelOpen(o => !o)}
        >
          Backtest
        </button>
      </header>
      <div className="app-body">
        <main className="app-main">
          <ChartView
            key={`${market.symbol}-${interval}`}
            symbol={market.symbol}
            interval={interval}
            session={showSession}
            pivotOptions={pivotOptions.options}
            rangeSelection={{ start: rangeStart, end: rangeEnd }}
            onChartClick={onChartClick}
            onChartContextMenu={(time, x, y, candle) => {
              if (time !== null) setCtxMenu({ time, x, y, candle })
            }}
          />
          {replayActive && (
            <PlaybackControls
              snap={s}
              onPlay={() => engine.play()}
              onPause={() => engine.pause()}
              onStepForward={() => void engine.stepForward()}
              onStepBack={() => engine.stepBack()}
              onRestart={() => void engine.restart()}
              onStop={() => void engine.stop()}
              onSpeed={sp => engine.setSpeed(sp)}
              onAutoResume={v => engine.setAutoResume(v)}
            />
          )}
        </main>
        {panelOpen && (
          <BacktestPanel
            snap={s}
            config={config}
            onConfig={setConfig}
            market={market.symbol}
            interval={interval}
            savedCandles={savedCandles.saved}
            onRemoveSaved={savedCandles.remove}
            onClearSaved={savedCandles.clear}
            pivotOptions={pivotOptions.options}
            onPivotOptions={(patch: Partial<PivotOptions>) => pivotOptions.set(patch)}
            presets={presets.presets}
            onSavePreset={savePreset}
            onLoadPreset={loadPreset}
            onRemovePreset={presets.remove}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            picking={picking}
            onPick={setPicking}
            onStart={() => {
              if (rangeStart !== undefined && rangeEnd !== undefined) {
                startSession(config.mode, rangeStart, rangeEnd)
              }
            }}
            onStop={() => void engine.stop()}
            onLoadSession={id => void engine.loadSession(id)}
          />
        )}
      </div>
      {ctxMenu && (
        <ChartContextMenu
          menu={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onSaveCandle={candle =>
            savedCandles.save({ market: market.symbol, interval, candle })
          }
          onSetStart={t => {
            setRangeStart(t)
            setPanelOpen(true)
          }}
          onSetEnd={t => {
            setRangeEnd(t)
            setPanelOpen(true)
          }}
          onStartReplayHere={t => {
            const end = Math.floor(Date.now() / 1000)
            setRangeStart(t)
            setRangeEnd(end)
            setConfig(c => ({ ...c, mode: "replay" }))
            setPanelOpen(true)
            startSession("replay", t, end)
          }}
        />
      )}
    </div>
  )
}
