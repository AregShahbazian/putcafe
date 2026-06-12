const BASE = "https://api.binance.com"

export interface Market {
  symbol: string
  baseAsset: string
  quoteAsset: string
}

export interface Candle {
  time: number // unix seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export const KLINE_LIMIT = 1000

interface ExchangeInfoSymbol {
  symbol: string
  baseAsset: string
  quoteAsset: string
  status: string
  isSpotTradingAllowed: boolean
}

export async function fetchMarkets(): Promise<Market[]> {
  const res = await fetch(`${BASE}/api/v3/exchangeInfo`)
  if (!res.ok) throw new Error(`exchangeInfo failed: ${res.status}`)
  const data: { symbols: ExchangeInfoSymbol[] } = await res.json()
  return data.symbols
    .filter(s => s.status === "TRADING" && s.isSpotTradingAllowed && s.quoteAsset === "USDT")
    .map(({ symbol, baseAsset, quoteAsset }) => ({ symbol, baseAsset, quoteAsset }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
}

export const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800,
}

type Kline = [number, string, string, string, string, string, ...unknown[]]

/** All candles with openTime in [startSec, endSec] (unix seconds), paginated forward. */
export async function fetchKlinesRange(
  symbol: string,
  interval: string,
  startSec: number,
  endSec: number,
): Promise<Candle[]> {
  const out: Candle[] = []
  let cursor = startSec * 1000
  const endMs = endSec * 1000
  while (cursor <= endMs) {
    const params = new URLSearchParams({
      symbol,
      interval,
      limit: String(KLINE_LIMIT),
      startTime: String(cursor),
      endTime: String(endMs),
    })
    const res = await fetch(`${BASE}/api/v3/klines?${params}`)
    if (!res.ok) throw new Error(`klines failed: ${res.status}`)
    const data: Kline[] = await res.json()
    if (data.length === 0) break
    for (const k of data) {
      out.push({
        time: Math.floor(k[0] / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      })
    }
    if (data.length < KLINE_LIMIT) break
    cursor = data[data.length - 1][0] + 1
  }
  return out
}

export async function fetchKlines(
  symbol: string,
  interval: string,
  endTime?: number, // ms, exclusive upper bound
): Promise<Candle[]> {
  const params = new URLSearchParams({ symbol, interval, limit: String(KLINE_LIMIT) })
  if (endTime !== undefined) params.set("endTime", String(endTime))
  const res = await fetch(`${BASE}/api/v3/klines?${params}`)
  if (!res.ok) throw new Error(`klines failed: ${res.status}`)
  const data: Kline[] = await res.json()
  return data.map(k => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }))
}
