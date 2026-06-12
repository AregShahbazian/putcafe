import { useEffect, useRef, useState } from "react"
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts"
import { fetchKlines, KLINE_LIMIT, type Candle } from "../binance/api"
import { bot, type Pivot, type PivotOptions, type PivotSimResult, type Trade } from "../api/backend"
import { RangeHighlight, type RangeSelection } from "./RangeHighlight"
import { PivotMarkers } from "./PivotMarkers"

const TRADE_MARKER_SIZE = 1.4 // 40% larger than the default arrow markers

const UP = "#26a69a"
const DOWN = "#ef5350"
const PIVOT_HIGH = "#f0a431"
const PIVOT_LOW = "#42a5f5"
const REVERSE = "#f0a431"
const ENTRY_LINE = "#b2b5be"
const LOAD_MORE_THRESHOLD = 50

export interface SessionView {
  candles: Candle[]
  preCandles: Candle[]
  upTo: number
  trades: Trade[]
  pivots: Pivot[]
  pivotSim: PivotSimResult | null // present for the `pivot` algo
  fitRange: boolean
}

interface Props {
  symbol: string
  interval: string
  session: SessionView | null
  pivotOptions: PivotOptions
  rangeSelection: RangeSelection
  onChartClick?: (time: number) => void
  onChartContextMenu?: (time: number | null, x: number, y: number, candle: Candle | null) => void
}

function toSeriesCandle(c: Candle, color?: string) {
  const bar = { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }
  return color ? { ...bar, color, borderColor: color, wickColor: color } : bar
}

function toVolumeBar(c: Candle) {
  return { time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? UP : DOWN }
}

// Pivot-algo entry (arrow) + exit (circle) markers, clipped to the cursor.
function pivotMarkers(sim: PivotSimResult, cutoff: number): SeriesMarker<Time>[] {
  const out: SeriesMarker<Time>[] = []
  for (const t of sim.trades) {
    if (t.entryTime <= cutoff) {
      const long = t.side === "long"
      out.push({
        time: t.entryTime as UTCTimestamp,
        position: long ? "belowBar" : "aboveBar",
        color: long ? UP : DOWN,
        shape: long ? "arrowUp" : "arrowDown",
        text: long ? "L" : "S",
        size: TRADE_MARKER_SIZE,
      })
    }
    if (t.exitTime !== null && t.exitReason !== "open" && t.exitTime <= cutoff) {
      const color = t.exitReason === "tp" ? UP : t.exitReason === "sl" ? DOWN : REVERSE
      out.push({
        time: t.exitTime as UTCTimestamp,
        position: t.side === "long" ? "aboveBar" : "belowBar",
        color,
        shape: "circle",
        text: t.exitReason === "reverse" ? "R" : t.exitReason.toUpperCase(),
        size: TRADE_MARKER_SIZE,
      })
    }
  }
  return out
}

function Legend({ candle }: { candle: Candle | null }) {
  if (!candle) return null
  const color = candle.close >= candle.open ? UP : DOWN
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 8 })
  return (
    <div className="chart-legend">
      <span>O <b style={{ color }}>{fmt(candle.open)}</b></span>
      <span>H <b style={{ color }}>{fmt(candle.high)}</b></span>
      <span>L <b style={{ color }}>{fmt(candle.low)}</b></span>
      <span>C <b style={{ color }}>{fmt(candle.close)}</b></span>
      <span>V <b style={{ color }}>{fmt(candle.volume)}</b></span>
    </div>
  )
}

export default function ChartView({
  symbol,
  interval,
  session,
  pivotOptions,
  rangeSelection,
  onChartClick,
  onChartContextMenu,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const priceLinesRef = useRef<IPriceLine[]>([])
  const pivotMarkersRef = useRef<PivotMarkers | null>(null)
  const rangeRef = useRef<RangeHighlight | null>(null)
  const candlesRef = useRef<Candle[]>([])
  const sessionActiveRef = useRef(false)
  const lastUpToRef = useRef(0)
  const fitDoneRef = useRef(false)
  const pivotKeyRef = useRef("")
  const clickRef = useRef(onChartClick)
  const ctxMenuRef = useRef(onChartContextMenu)
  clickRef.current = onChartClick
  ctxMenuRef.current = onChartContextMenu

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<Candle | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [liveCandles, setLiveCandles] = useState<Candle[]>([])
  const [livePivots, setLivePivots] = useState<Pivot[]>([])

  const sessionActive = session !== null
  sessionActiveRef.current = sessionActive

  // Chart + series + subscriptions — once per mount.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const chart = createChart(container, {
      autoSize: true,
      layout: { background: { color: "#131722" }, textColor: "#d1d4dc" },
      grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
      timeScale: { timeVisible: true, borderColor: "#2a2e39" },
      rightPriceScale: { borderColor: "#2a2e39" },
    })
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    })
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    })
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })

    const range = new RangeHighlight()
    candleSeries.attachPrimitive(range)
    const pivotMarks = new PivotMarkers()
    candleSeries.attachPrimitive(pivotMarks)
    const markers = createSeriesMarkers(candleSeries, [])

    chart.subscribeClick(param => {
      if (param.time !== undefined) clickRef.current?.(param.time as number)
    })
    chart.subscribeCrosshairMove(param => {
      const candles = candlesRef.current
      if (!param.time) {
        setHovered(candles.length > 0 ? candles[candles.length - 1] : null)
        return
      }
      setHovered(candles.find(c => c.time === param.time) ?? null)
    })
    const onContextMenu = (e: MouseEvent) => {
      if (!ctxMenuRef.current) return
      e.preventDefault()
      const rect = container.getBoundingClientRect()
      const time = chart.timeScale().coordinateToTime(e.clientX - rect.left)
      const candle = time === null ? null : (candlesRef.current.find(c => c.time === time) ?? null)
      ctxMenuRef.current(time === null ? null : (time as number), e.clientX, e.clientY, candle)
    }
    container.addEventListener("contextmenu", onContextMenu)

    chartRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries
    markersRef.current = markers
    pivotMarkersRef.current = pivotMarks
    rangeRef.current = range

    return () => {
      container.removeEventListener("contextmenu", onContextMenu)
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      markersRef.current = null
      pivotMarkersRef.current = null
      rangeRef.current = null
    }
  }, [])

  // Live mode: initial fetch + lazy older-history loading. Paused while a session
  // renders. Data lands in liveCandles state; the render effect below draws it.
  useEffect(() => {
    const chart = chartRef.current
    const candleSeries = candleSeriesRef.current
    if (!chart || !candleSeries || sessionActive) return

    let disposed = false
    let loadingOlder = false
    let exhausted = false
    setLoading(true)
    setError(null)

    const loadOlder = async () => {
      const candles = candlesRef.current
      if (loadingOlder || exhausted || candles.length === 0 || sessionActiveRef.current) return
      loadingOlder = true
      try {
        const older = await fetchKlines(symbol, interval, candles[0].time * 1000 - 1)
        if (disposed) return
        if (older.length < KLINE_LIMIT) exhausted = true
        if (older.length > 0) setLiveCandles(prev => [...older, ...prev])
      } catch {
        // transient — retried on the next range change
      } finally {
        loadingOlder = false
      }
    }

    const onRange = () => {
      const range = chart.timeScale().getVisibleLogicalRange()
      if (!range) return
      const bars = candleSeries.barsInLogicalRange(range)
      if (bars && bars.barsBefore < LOAD_MORE_THRESHOLD) void loadOlder()
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    fetchKlines(symbol, interval)
      .then(initial => {
        if (disposed) return
        setLiveCandles(initial)
        if (initial.length < KLINE_LIMIT) exhausted = true
        setHovered(initial.length > 0 ? initial[initial.length - 1] : null)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (disposed) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })

    return () => {
      disposed = true
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
    }
  }, [symbol, interval, retryKey, sessionActive])

  // Live pivots, indicator-style: recompute over everything drawn whenever more
  // history loads or the options change. Stateless bot call — no session needed.
  useEffect(() => {
    if (sessionActive || !pivotOptions.enabled || liveCandles.length === 0) {
      setLivePivots([])
      return
    }
    let stale = false
    bot
      .analyze(liveCandles, pivotOptions)
      .then(r => {
        if (!stale) setLivePivots(r.pivots ?? [])
      })
      .catch(() => {
        // bot unreachable — chart stays usable, pivots just don't show
        if (!stale) setLivePivots([])
      })
    return () => {
      stale = true
    }
  }, [liveCandles, pivotOptions, sessionActive])

  // Live render: candles + volume, pivot candles painted in the pivot colors.
  useEffect(() => {
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    if (!candleSeries || !volumeSeries || sessionActive) return
    const colors = new Map(
      livePivots.map(pv => [pv.time, pv.type === "high" ? PIVOT_HIGH : PIVOT_LOW] as [number, string]),
    )
    candlesRef.current = liveCandles
    candleSeries.setData(liveCandles.map(c => toSeriesCandle(c, colors.get(c.time))))
    volumeSeries.setData(liveCandles.map(toVolumeBar))
  }, [liveCandles, livePivots, sessionActive])

  // Session mode: pre-start history as context + range candles up to `upTo`;
  // incremental update when stepping forward, full setData on jumps.
  useEffect(() => {
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    const chart = chartRef.current
    if (!candleSeries || !volumeSeries || !chart) return
    if (!session) {
      lastUpToRef.current = 0
      fitDoneRef.current = false
      pivotKeyRef.current = ""
      return
    }
    setLoading(false)
    setError(null)
    const visible = [...session.preCandles, ...session.candles.slice(0, session.upTo)]
    // Confirmed pivot candles are drawn in the pivot colors; a newly confirmed
    // (or live-options-changed) pivot lies behind the cursor, so repaint via setData.
    const cutoff = visible.length > 0 ? visible[visible.length - 1].time : 0
    const confirmed = session.pivots.filter(pv => pv.confirmedAt <= cutoff)
    const pivotColors = new Map(confirmed.map(pv => [pv.time, pv.type === "high" ? PIVOT_HIGH : PIVOT_LOW] as [number, string]))
    const pivotKey = confirmed.map(pv => `${pv.time}${pv.type}`).join()
    const entering = lastUpToRef.current === 0
    if (visible.length === lastUpToRef.current + 1 && !entering && pivotKey === pivotKeyRef.current) {
      const next = visible[visible.length - 1]
      candleSeries.update(toSeriesCandle(next))
      volumeSeries.update(toVolumeBar(next))
    } else {
      candleSeries.setData(visible.map(c => toSeriesCandle(c, pivotColors.get(c.time))))
      volumeSeries.setData(visible.map(toVolumeBar))
    }
    lastUpToRef.current = visible.length
    pivotKeyRef.current = pivotKey
    candlesRef.current = visible
    if (visible.length > 0) setHovered(visible[visible.length - 1])

    if (session.fitRange && !fitDoneRef.current && session.candles.length > 0) {
      // Finished session: whole backtest range with some candle padding around it.
      fitDoneRef.current = true
      const pad = Math.max(8, Math.round(session.candles.length * 0.07))
      chart.timeScale().setVisibleLogicalRange({
        from: session.preCandles.length - pad,
        to: visible.length - 1 + pad,
      })
    } else if (entering && !session.fitRange) {
      // Replay entry: park the viewport at the cursor with recent context behind it,
      // leaving right-edge whitespace so playback visibly appends candles.
      chart.timeScale().setVisibleLogicalRange({
        from: visible.length - 120,
        to: visible.length + 20,
      })
    }
  }, [session])

  // Pivots are drawn as triangles (a custom primitive); only trades use the arrow
  // markers plugin. A pivot only shows once the cursor reaches the candle that
  // confirmed it (no-lookahead honesty).
  useEffect(() => {
    const markers = markersRef.current
    const pivotMarks = pivotMarkersRef.current
    if (!markers || !pivotMarks) return
    if (!session) {
      markers.setMarkers([]) // no trades on the live chart
      pivotMarks.setPivots(livePivots.map(pv => ({ time: pv.time, type: pv.type, price: pv.price })))
      return
    }
    const cutoff = session.upTo > 0 ? session.candles[session.upTo - 1].time : 0
    // Pivot algo: entry/exit markers from the sim; DCA: spot-buy markers.
    const trades: SeriesMarker<Time>[] = session.pivotSim
      ? pivotMarkers(session.pivotSim, cutoff)
      : session.trades
          .filter(t => t.time <= cutoff)
          .map(t => ({
            time: t.time as UTCTimestamp,
            position: "belowBar",
            color: UP,
            shape: "arrowUp",
            text: `B ${t.quoteAmount}`,
            size: TRADE_MARKER_SIZE,
          }))
    markers.setMarkers(trades.sort((a, b) => (a.time as number) - (b.time as number)))
    pivotMarks.setPivots(
      session.pivots
        .filter(pv => pv.confirmedAt <= cutoff)
        .map(pv => ({ time: pv.time, type: pv.type, price: pv.price })),
    )
  }, [session, livePivots])

  // Pivot bracket lines (entry / SL / TP) for the position open at the cursor.
  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series) return
    for (const line of priceLinesRef.current) series.removePriceLine(line)
    priceLinesRef.current = []
    if (!session?.pivotSim || session.upTo === 0) return
    const cutoff = session.candles[session.upTo - 1].time
    // The trade entered at/before the cursor and not yet exited (or exiting later).
    const open = session.pivotSim.trades.find(
      t => t.entryTime <= cutoff && (t.exitTime === null || t.exitTime > cutoff),
    )
    if (!open) return
    const add = (price: number, color: string, title: string) =>
      priceLinesRef.current.push(
        series.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title }),
      )
    add(open.entryPrice, ENTRY_LINE, `Entry ${open.side}`)
    add(open.slPrice, DOWN, "SL")
    add(open.tpPrice, UP, "TP")
  }, [session])

  // Backtest range highlight (live + session).
  useEffect(() => {
    rangeRef.current?.setSelection(rangeSelection)
  }, [rangeSelection])

  return (
    <div className="chart-wrap">
      <div ref={containerRef} className="chart-container" />
      <Legend candle={hovered} />
      {loading && <div className="chart-overlay">Loading {symbol}…</div>}
      {error && (
        <div className="chart-overlay chart-error">
          <p>Failed to load {symbol}: {error}</p>
          <button onClick={() => setRetryKey(k => k + 1)}>Retry</button>
        </div>
      )}
    </div>
  )
}
