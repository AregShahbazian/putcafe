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

const DEFAULT_MARKET: Market = { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT" }

const DEFAULT_CONFIG: PanelConfig = {
  mode: "replay",
  quoteAmount: 10,
  frequencySec: 7 * 86400,
  startingBalance: 1000,
  feesEnabled: true,
}

export default function App() {
  const [markets, setMarkets] = useState<Market[]>([])
  const [marketsError, setMarketsError] = useState<string | null>(null)
  const [market, setMarket] = useState<Market>(DEFAULT_MARKET)
  const [interval, setInterval] = useState<Interval>("1h")

  const [panelOpen, setPanelOpen] = useState(false)
  const [config, setConfig] = useState<PanelConfig>(DEFAULT_CONFIG)
  const [rangeStart, setRangeStart] = useState<number | undefined>()
  const [rangeEnd, setRangeEnd] = useState<number | undefined>()
  const [picking, setPicking] = useState<PickerField>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)

  const engineRef = useRef<BacktestEngine | null>(null)
  const [snap, setSnap] = useState<EngineSnapshot | null>(null)
  if (engineRef.current === null) engineRef.current = new BacktestEngine(setSnap)
  const engine = engineRef.current
  const s: EngineSnapshot = snap ?? engine.snapshot

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
      algo: "dca",
      algoConfig: { quoteAmount: config.quoteAmount, frequencySec: config.frequencySec },
      startingBalance: config.startingBalance,
      feesEnabled: config.feesEnabled,
    }
    void engine.start(sessionConfig)
  }

  const onChartClick = (time: number) => {
    if (!picking) return
    if (picking === "start") setRangeStart(time)
    else setRangeEnd(time)
    setPicking(null)
  }

  const replayActive =
    s.mode === "replay" && ["ready", "playing", "paused", "finished"].includes(s.status)
  const showSession: SessionView | null =
    s.session && (replayActive || (s.mode === "headless" && s.status === "finished"))
      ? {
          candles: s.candles,
          preCandles: s.preCandles,
          upTo: s.upTo,
          trades: s.trades,
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
            rangeSelection={{ start: rangeStart, end: rangeEnd }}
            onChartClick={onChartClick}
            onChartContextMenu={(time, x, y) => {
              if (time !== null) setCtxMenu({ time, x, y })
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
