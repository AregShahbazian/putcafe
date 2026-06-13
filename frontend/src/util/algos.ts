import type { AlgoName, AlgoParams } from "../api/backend"

/** One tunable knob for an indicator algo, rendered as a field in the panel. */
export interface AlgoParamSpec {
  key: string
  label: string
  type: "int" | "float" | "select"
  min?: number
  step?: number
  options?: string[]
}

export interface AlgoMeta {
  value: AlgoName
  label: string
  blurb: string
  params: AlgoParamSpec[]
  /** Tuned indicator defaults (from the parameter sweep over BTC/ETH/BNB/SOL 1h). */
  defaults: AlgoParams
  /** Tuned bracket defaults that paired best with `defaults` in the sweep. */
  bracket: { slCapPct: number; tpSlRatio: number }
}

/** The signal-driven indicator algos. Defaults are the best-consistency combos
 * from `backend/bot/tuner.py` (median per-window ROI gated by % profitable
 * windows). Donchian & Bollinger-breakout were the consistently-green pair. */
export const INDICATOR_ALGOS: AlgoMeta[] = [
  {
    value: "donchian",
    label: "Donchian breakout (trend)",
    blurb: "Long on a break above the prior-N-candle high, short below the low; stop-and-reverse.",
    params: [{ key: "period", label: "Channel period", type: "int", min: 2, step: 1 }],
    defaults: { period: 30 },
    bracket: { slCapPct: 6, tpSlRatio: 1.5 },
  },
  {
    value: "bollinger",
    label: "Bollinger breakout",
    blurb: "Long when price closes above the upper band, short below the lower; carries the side.",
    params: [
      { key: "period", label: "MA period", type: "int", min: 2, step: 1 },
      { key: "mult", label: "Band width (σ)", type: "float", min: 0.5, step: 0.1 },
    ],
    defaults: { period: 30, mult: 2.0 },
    bracket: { slCapPct: 4, tpSlRatio: 2 },
  },
  {
    value: "ma_cross",
    label: "MA crossover (trend)",
    blurb: "Long while the fast MA is above the slow MA, short below — golden/death cross.",
    params: [
      { key: "fast", label: "Fast period", type: "int", min: 1, step: 1 },
      { key: "slow", label: "Slow period", type: "int", min: 2, step: 1 },
      { key: "maType", label: "MA type", type: "select", options: ["ema", "sma"] },
    ],
    defaults: { fast: 10, slow: 200, maType: "ema" },
    bracket: { slCapPct: 6, tpSlRatio: 1.5 },
  },
  {
    value: "macd",
    label: "MACD (trend)",
    blurb: "Long while the MACD line is above its signal line, short below.",
    params: [
      { key: "fast", label: "Fast EMA", type: "int", min: 1, step: 1 },
      { key: "slow", label: "Slow EMA", type: "int", min: 2, step: 1 },
      { key: "signal", label: "Signal EMA", type: "int", min: 1, step: 1 },
    ],
    defaults: { fast: 8, slow: 21, signal: 9 },
    bracket: { slCapPct: 2, tpSlRatio: 1.5 },
  },
  {
    value: "rsi_revert",
    label: "RSI mean-reversion",
    blurb: "Buy when RSI is oversold, fade when overbought, flat in the neutral band.",
    params: [
      { key: "period", label: "RSI period", type: "int", min: 2, step: 1 },
      { key: "oversold", label: "Oversold ≤", type: "int", min: 1, step: 1 },
      { key: "overbought", label: "Overbought ≥", type: "int", min: 1, step: 1 },
    ],
    defaults: { period: 7, oversold: 20, overbought: 80 },
    bracket: { slCapPct: 2, tpSlRatio: 1.5 },
  },
]

export const ALGO_META: Record<string, AlgoMeta> = Object.fromEntries(
  INDICATOR_ALGOS.map(a => [a.value, a]),
)

export const isIndicatorAlgo = (algo: AlgoName): boolean => algo in ALGO_META
