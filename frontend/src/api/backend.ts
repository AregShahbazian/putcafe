import type { Candle } from "../binance/api"

const BASE = import.meta.env.VITE_API_BASE ?? ""

export interface AlgoConfig {
  quoteAmount: number
  frequencySec: number
}

/** Pivot-breakout strategy params (the `pivot` algo). `lookback` rides on the
 * shared PivotOptions; these are the strategy-specific knobs. */
export interface PivotParams {
  tpSlRatio: number
  slCapPct: number
  quoteAmount: number // isolated margin per position (USDT); notional = margin × leverage
  leverage: number // ×1–×125
}

export interface SessionConfig {
  market: string
  interval: string
  startTime: number // unix seconds (first session candle openTime)
  endTime: number // unix seconds (last session candle openTime)
  mode: "replay" | "headless"
  algo: "dca" | "pivot"
  algoConfig: AlgoConfig
  pivotParams?: PivotParams // present when algo === "pivot"
  startingBalance: number
  feesEnabled: boolean
}

export interface Trade {
  time: number
  side: "buy"
  price: number
  baseQty: number
  quoteAmount: number
  fee: number
}

export interface Session extends SessionConfig {
  id: string
  createdAt: string
  status: "active" | "finished"
  quoteBalance: number
  baseQty: number
  avgEntry: number | null
  feesPaid: number
}

export interface Decision {
  side: "buy"
  type: "market"
  quoteAmount: number
}

export interface PivotOptions {
  enabled: boolean
  lookback: number
  alternation: boolean
}

export interface Pivot {
  time: number
  type: "high" | "low"
  price: number
  confirmedAt: number
}

export interface PivotTrade {
  side: "long" | "short"
  entryTime: number
  entryPrice: number
  exitTime: number | null
  exitPrice: number | null
  exitReason: "tp" | "sl" | "reverse" | "liq" | "open"
  qty: number
  slPrice: number
  tpPrice: number
  liqPrice: number
  notional: number
  margin: number
  pnl: number | null // realized; null while open, never below -margin
  feePaid: number
}

export interface PivotSimResult {
  pivots: Pivot[] | null
  trades: PivotTrade[]
  equity: number
  realizedPnl: number
  wins: number
  losses: number
  leverage: number
  bust: boolean // an entry was refused because equity < margin
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    // Only when a body exists — Fastify 400s empty bodies typed as JSON.
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const err = new Error(`${path}: ${res.status} ${body}`) as Error & { status: number }
    err.status = res.status
    throw err
  }
  return res.json() as Promise<T>
}

export const positions = {
  createSession: (config: SessionConfig) =>
    req<Session>("/api/positions/sessions", { method: "POST", body: JSON.stringify(config) }),
  listSessions: () => req<Session[]>("/api/positions/sessions"),
  getSession: (id: string) => req<Session & { trades: Trade[] }>(`/api/positions/sessions/${id}`),
  order: (id: string, order: { time: number; side: "buy"; quoteAmount: number; price: number }) =>
    req<Session & { filled: boolean; trade: Trade }>(`/api/positions/sessions/${id}/orders`, {
      method: "POST",
      body: JSON.stringify(order),
    }),
  finish: (id: string) => req<{ ok: true }>(`/api/positions/sessions/${id}/finish`, { method: "POST" }),
  remove: (id: string) => req<{ ok: true }>(`/api/positions/sessions/${id}`, { method: "DELETE" }),
  clearSessions: (exceptId?: string) =>
    req<{ ok: true; deleted: number }>(
      `/api/positions/sessions${exceptId ? `?except=${exceptId}` : ""}`,
      { method: "DELETE" },
    ),
}

export const bot = {
  seed: (id: string, body: { algo: "dca"; config: AlgoConfig; candles: Candle[]; options?: PivotOptions }) =>
    req<{ ok: true; pivots: Pivot[] | null }>(`/api/bot/sessions/${id}/seed`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  step: (id: string, candle: Candle) =>
    req<{ decisions: Decision[]; pivots: Pivot[] | null }>(`/api/bot/sessions/${id}/step`, {
      method: "POST",
      body: JSON.stringify({ candle }),
    }),
  run: (id: string, candles: Candle[]) =>
    req<{ steps: number; trades: number; pivots: Pivot[] | null }>(`/api/bot/sessions/${id}/run`, {
      method: "POST",
      body: JSON.stringify({ candles }),
    }),
  setOptions: (id: string, pivots: PivotOptions) =>
    req<{ ok: true; pivots: Pivot[] | null }>(`/api/bot/sessions/${id}/options`, {
      method: "PUT",
      body: JSON.stringify({ pivots }),
    }),
  analyze: (candles: Candle[], pivots: PivotOptions) =>
    req<{ pivots: Pivot[] | null }>(`/api/bot/analyze`, {
      method: "POST",
      body: JSON.stringify({ candles, pivots }),
    }),
  simulate: (
    candles: Candle[],
    pivots: PivotOptions,
    params: PivotParams & { feesEnabled: boolean; startingBalance: number },
  ) =>
    req<PivotSimResult>(`/api/bot/simulate`, {
      method: "POST",
      body: JSON.stringify({ candles, pivots, params }),
    }),
}
