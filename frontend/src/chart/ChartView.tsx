import { useEffect, useRef, useState } from "react"
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts"
import { fetchKlines, KLINE_LIMIT, type Candle } from "../binance/api"
import type { Trade } from "../api/backend"
import { RangeHighlight, type RangeSelection } from "./RangeHighlight"

const UP = "#26a69a"
const DOWN = "#ef5350"
const LOAD_MORE_THRESHOLD = 50

export interface SessionView {
  candles: Candle[]
  preCandles: Candle[]
  upTo: number
  trades: Trade[]
  fitRange: boolean
}

interface Props {
  symbol: string
  interval: string
  session: SessionView | null
  rangeSelection: RangeSelection
  onChartClick?: (time: number) => void
  onChartContextMenu?: (time: number | null, x: number, y: number, candle: Candle | null) => void
}

function toSeriesCandle(c: Candle) {
  return { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }
}

function toVolumeBar(c: Candle) {
  return { time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? UP : DOWN }
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
  rangeSelection,
  onChartClick,
  onChartContextMenu,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const rangeRef = useRef<RangeHighlight | null>(null)
  const candlesRef = useRef<Candle[]>([])
  const sessionActiveRef = useRef(false)
  const lastUpToRef = useRef(0)
  const fitDoneRef = useRef(false)
  const clickRef = useRef(onChartClick)
  const ctxMenuRef = useRef(onChartContextMenu)
  clickRef.current = onChartClick
  ctxMenuRef.current = onChartContextMenu

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<Candle | null>(null)
  const [retryKey, setRetryKey] = useState(0)

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
    rangeRef.current = range

    return () => {
      container.removeEventListener("contextmenu", onContextMenu)
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      markersRef.current = null
      rangeRef.current = null
    }
  }, [])

  // Live mode: initial fetch + lazy older-history loading. Paused while a session renders.
  useEffect(() => {
    const chart = chartRef.current
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    if (!chart || !candleSeries || !volumeSeries || sessionActive) return

    let disposed = false
    let loadingOlder = false
    let exhausted = false
    setLoading(true)
    setError(null)

    const setAll = (candles: Candle[]) => {
      candlesRef.current = candles
      candleSeries.setData(candles.map(toSeriesCandle))
      volumeSeries.setData(candles.map(toVolumeBar))
    }

    const loadOlder = async () => {
      const candles = candlesRef.current
      if (loadingOlder || exhausted || candles.length === 0 || sessionActiveRef.current) return
      loadingOlder = true
      try {
        const older = await fetchKlines(symbol, interval, candles[0].time * 1000 - 1)
        if (disposed) return
        if (older.length < KLINE_LIMIT) exhausted = true
        if (older.length > 0) setAll([...older, ...candlesRef.current])
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
        setAll(initial)
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
      return
    }
    setLoading(false)
    setError(null)
    const visible = [...session.preCandles, ...session.candles.slice(0, session.upTo)]
    const entering = lastUpToRef.current === 0
    if (visible.length === lastUpToRef.current + 1 && !entering) {
      const next = visible[visible.length - 1]
      candleSeries.update(toSeriesCandle(next))
      volumeSeries.update(toVolumeBar(next))
    } else {
      candleSeries.setData(visible.map(toSeriesCandle))
      volumeSeries.setData(visible.map(toVolumeBar))
    }
    lastUpToRef.current = visible.length
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

  // Trade markers, clipped to the replay cursor.
  useEffect(() => {
    const markers = markersRef.current
    if (!markers) return
    if (!session) {
      markers.setMarkers([])
      return
    }
    const cutoff = session.upTo > 0 ? session.candles[session.upTo - 1].time : 0
    const ms: SeriesMarker<Time>[] = session.trades
      .filter(t => t.time <= cutoff)
      .map(t => ({
        time: t.time as UTCTimestamp,
        position: "belowBar",
        color: UP,
        shape: "arrowUp",
        text: `B ${t.quoteAmount}`,
      }))
    markers.setMarkers(ms)
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
