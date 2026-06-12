import { useEffect, useRef, useState } from "react"
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts"
import { fetchKlines, KLINE_LIMIT, type Candle } from "../binance/api"

const UP = "#26a69a"
const DOWN = "#ef5350"
const LOAD_MORE_THRESHOLD = 50

interface Props {
  symbol: string
  interval: string
}

function toSeriesData(candles: Candle[]) {
  return candles.map(c => ({
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }))
}

function toVolumeData(candles: Candle[]) {
  return candles.map(c => ({
    time: c.time as UTCTimestamp,
    value: c.volume,
    color: c.close >= c.open ? UP : DOWN,
  }))
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

export default function ChartView({ symbol, interval }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<Candle | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let chart: IChartApi | null = null
    let candleSeries: ISeriesApi<"Candlestick"> | null = null
    let volumeSeries: ISeriesApi<"Histogram"> | null = null
    let candles: Candle[] = []
    let loadingOlder = false
    let exhausted = false

    setLoading(true)
    setError(null)
    setHovered(null)

    chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "#131722" },
        textColor: "#d1d4dc",
      },
      grid: {
        vertLines: { color: "#1e222d" },
        horzLines: { color: "#1e222d" },
      },
      timeScale: { timeVisible: true, borderColor: "#2a2e39" },
      rightPriceScale: { borderColor: "#2a2e39" },
    })

    candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    })
    volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    })
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })

    const setAllData = () => {
      candleSeries!.setData(toSeriesData(candles))
      volumeSeries!.setData(toVolumeData(candles))
    }

    const loadOlder = async () => {
      if (loadingOlder || exhausted || candles.length === 0) return
      loadingOlder = true
      try {
        const older = await fetchKlines(symbol, interval, candles[0].time * 1000 - 1)
        if (disposed) return
        if (older.length < KLINE_LIMIT) exhausted = true
        if (older.length > 0) {
          candles = [...older, ...candles]
          setAllData()
        }
      } catch {
        // transient — retried on the next range change
      } finally {
        loadingOlder = false
      }
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (!range || !candleSeries) return
      const bars = candleSeries.barsInLogicalRange(range)
      if (bars && bars.barsBefore < LOAD_MORE_THRESHOLD) void loadOlder()
    })

    chart.subscribeCrosshairMove(param => {
      if (!param.time || !candleSeries) {
        setHovered(candles.length > 0 ? candles[candles.length - 1] : null)
        return
      }
      const hit = candles.find(c => c.time === param.time)
      setHovered(hit ?? null)
    })

    fetchKlines(symbol, interval)
      .then(initial => {
        if (disposed) return
        candles = initial
        if (initial.length < KLINE_LIMIT) exhausted = true
        setAllData()
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
      chart?.remove()
    }
  }, [symbol, interval, retryKey])

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
