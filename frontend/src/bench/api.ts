/** Benchmark UI data layer (pc-benchmark-runner). Reads the bot's read-only
 * endpoints over /data/bench/results.db. Same BASE convention as api/backend.ts. */

const BASE = import.meta.env.VITE_API_BASE ?? ""

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const err = new Error(`${path}: ${res.status} ${body}`) as Error & { status: number }
    err.status = res.status
    throw err
  }
  return res.json() as Promise<T>
}

export interface AlgoSummary {
  config_hash: string
  algo: string
  sessions: number
  avg_return_pct: number
  median_return_pct: number
  best_return_pct: number
  worst_return_pct: number
  avg_win_rate: number
  avg_max_drawdown: number
  busts: number
}

export interface MarketAgg {
  exchange: string
  market: string
  resolution: string
  sessions: number
  avg_return_pct: number
  avg_win_rate: number
  avg_max_drawdown: number
}

export interface SessionRow {
  exchange: string
  market: string
  resolution: string
  range_start: number
  range_end: number
  return_pct: number
  win_rate: number
  max_drawdown: number
  trades: number
  bust: boolean
}

export const benchApi = {
  algos: () => get<{ algos: AlgoSummary[] }>("/api/bot/bench/algos").then((r) => r.algos),
  markets: (configHash: string) =>
    get<{ markets: MarketAgg[] }>(`/api/bot/bench/markets?config_hash=${configHash}`).then((r) => r.markets),
  sessions: (configHash: string, market?: string) =>
    get<{ sessions: SessionRow[] }>(
      `/api/bot/bench/sessions?config_hash=${configHash}${market ? `&market=${encodeURIComponent(market)}` : ""}`,
    ).then((r) => r.sessions),
}
