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

type Kline = [number, string, string, string, string, string, ...unknown[]]

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
