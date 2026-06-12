import type { Candle } from "../binance/api"

const BASE = import.meta.env.VITE_API_BASE ?? ""

/** Every algo: dca, pivot, and the indicator algos (signal-driven bracket). */
export type AlgoName = "dca" | "pivot" | "ma_cross" | "rsi_revert" | "bollinger" | "donchian" | "macd"

/** Indicator-algo knobs (fast/slow/period/oversold/…). Free-form so each algo
 * carries only its own keys; the backend reads what it needs. */
export type AlgoParams = Record<string, number | string>

/** Unified run params — futures-only. An algo ignores the knobs it doesn't use
 * (DCA: quoteAmount + frequencySec; pivot/indicators: quoteAmount as margin +
 * leverage + tpSlRatio + slCapPct; indicators also read algoParams). */
export interface FuturesParams {
  quoteAmount: number // DCA buy size / isolated margin per position (USDT)
  leverage: number // ×1–×125 (notional = margin × leverage)
  tpSlRatio: number
  slCapPct: number // SL distance from entry (%)
  frequencySec: number // DCA cadence
  algoParams?: AlgoParams // indicator-algo knobs
}

export interface SessionConfig {
  market: string
  interval: string
  startTime: number // unix seconds (first session candle openTime)
  endTime: number // unix seconds (last session candle openTime)
  mode: "replay" | "headless"
  algo: AlgoName
  params: FuturesParams
  startingBalance: number
  feesEnabled: boolean
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

/** A futures trade (a closed position side, or an open one with null exits). */
export interface PivotTrade {
  side: "long" | "short"
  entryTime: number
  entryPrice: number
  exitTime: number | null
  exitPrice: number | null
  exitReason: "tp" | "sl" | "reverse" | "liq" | "open"
  qty: number
  slPrice: number | null // null for bracket-less algos (DCA)
  tpPrice: number | null
  liqPrice: number
  notional: number
  margin: number
  leverage: number
  pnl: number | null // realized; null while open, never below -margin
  feePaid: number
}

/** One order in the ledger: entry stops, the reduce-only TP/SL bracket legs,
 * reverse/liq market exits — full lifecycle. `status` is the final state; the
 * at-cursor state is derived in `util/orders.ts`. */
export interface PivotOrder {
  id: number
  role: "entry" | "tp" | "sl" | "exit" | "liq"
  type: "stop_market" | "stop_limit" | "limit" | "market"
  side: "buy" | "sell"
  positionSide: "long" | "short"
  reduceOnly: boolean
  price: number
  qty: number
  pct: number | null // tp/sl distance from entry, signed %
  createdAt: number
  status: "open" | "filled" | "cancelled"
  filledAt: number | null
  fillPrice: number | null
  cancelledAt: number | null
  tradeIdx: number | null
}

export interface FuturesPosition {
  side: "long" | "short"
  entryTime: number
  entryPrice: number
  qty: number
  margin: number
  leverage: number
  notional: number
  liqPrice: number
  slPrice: number | null
  tpPrice: number | null
  feePaid: number
}

export interface Positions {
  long: FuturesPosition | null
  short: FuturesPosition | null
}

export interface FuturesEvent {
  time: number
  kind: "open" | "add" | "tp" | "sl" | "reverse" | "liq" | "bust"
  side?: "long" | "short"
  price?: number
  qty?: number
  pnl?: number
}

/** The engine snapshot — single source of truth for every algo. */
export interface FuturesSnapshot {
  pivots: Pivot[] | null
  positions: Positions
  trades: PivotTrade[]
  orders: PivotOrder[]
  events: FuturesEvent[]
  equity: number
  realizedPnl: number
  wins: number
  losses: number
  leverage: number
  bust: boolean // an entry was refused because the free balance < margin
}

/** Persisted session metadata (the snapshot rides along on getSession). */
export interface Session {
  id: string
  createdAt: string
  market: string
  interval: string
  startTime: number
  endTime: number
  mode: "replay" | "headless"
  algo: AlgoName
  params: FuturesParams
  startingBalance: number
  feesEnabled: boolean
  leverage: number
  status: "active" | "finished"
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
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

export interface CreateSessionBody extends SessionConfig {
  leverage: number
  snapshot: FuturesSnapshot
}

export const positions = {
  createSession: (body: CreateSessionBody) =>
    req<Session>("/api/positions/sessions", { method: "POST", body: JSON.stringify(body) }),
  listSessions: () => req<Session[]>("/api/positions/sessions"),
  getSession: (id: string) =>
    req<Session & { snapshot: FuturesSnapshot }>(`/api/positions/sessions/${id}`),
  finish: (id: string) => req<{ ok: true }>(`/api/positions/sessions/${id}/finish`, { method: "POST" }),
  remove: (id: string) => req<{ ok: true }>(`/api/positions/sessions/${id}`, { method: "DELETE" }),
  clearSessions: (exceptId?: string) =>
    req<{ ok: true; deleted: number }>(
      `/api/positions/sessions${exceptId ? `?except=${exceptId}` : ""}`,
      { method: "DELETE" },
    ),
}

export const bot = {
  run: (
    candles: Candle[],
    algo: AlgoName,
    pivots: PivotOptions,
    params: FuturesParams & { feesEnabled: boolean; startingBalance: number },
  ) =>
    req<FuturesSnapshot>("/api/bot/futures/run", {
      method: "POST",
      body: JSON.stringify({ candles, algo, pivots, params }),
    }),
  analyze: (candles: Candle[], pivots: PivotOptions) =>
    req<{ pivots: Pivot[] | null }>("/api/bot/analyze", {
      method: "POST",
      body: JSON.stringify({ candles, pivots }),
    }),
}
