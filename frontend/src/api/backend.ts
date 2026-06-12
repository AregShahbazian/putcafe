import type { Candle } from "../binance/api"

const BASE = import.meta.env.VITE_API_BASE ?? ""

export interface AlgoConfig {
  quoteAmount: number
  frequencySec: number
}

export interface SessionConfig {
  market: string
  interval: string
  startTime: number // unix seconds (first session candle openTime)
  endTime: number // unix seconds (last session candle openTime)
  mode: "replay" | "headless"
  algo: "dca"
  algoConfig: AlgoConfig
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
}

export const bot = {
  seed: (id: string, body: { algo: "dca"; config: AlgoConfig; candles: Candle[] }) =>
    req<{ ok: true }>(`/api/bot/sessions/${id}/seed`, { method: "POST", body: JSON.stringify(body) }),
  step: (id: string, candle: Candle) =>
    req<{ decisions: Decision[] }>(`/api/bot/sessions/${id}/step`, {
      method: "POST",
      body: JSON.stringify({ candle }),
    }),
  run: (id: string, candles: Candle[]) =>
    req<{ steps: number; trades: number }>(`/api/bot/sessions/${id}/run`, {
      method: "POST",
      body: JSON.stringify({ candles }),
    }),
}
