/** Roll a random backtest window inside a market's available history. Pure —
 * the only entropy is the injectable `rand`, so the result is unit/e2e
 * assertable and the dice stay out of the reproducible part (the absolute
 * range it returns). See ~/ai/putcafe/features/randoms/design.md. */

export const DEFAULT_MIN_BARS = 200
export const DEFAULT_MAX_BARS = 1000

export interface RandomRangeOpts {
  minBars?: number
  maxBars?: number
}

export interface KlineBounds {
  earliest: number // unix seconds, first available candle open-time
  latest: number // unix seconds, last closed candle open-time
}

/** A random candle-aligned `{start, end}` within `bounds`, sized between
 * min/max bars of `intervalSec`. The window is clamped to what the available
 * history allows, so short histories never overflow. */
export function rollRandomRange(
  bounds: KlineBounds,
  intervalSec: number,
  opts: RandomRangeOpts = {},
  rand: () => number = Math.random,
): { start: number; end: number } {
  const totalBars = Math.floor((bounds.latest - bounds.earliest) / intervalSec)
  if (totalBars < 1) throw new Error("not enough history to pick a range")
  const maxBars = Math.min(opts.maxBars ?? DEFAULT_MAX_BARS, totalBars)
  const minBars = Math.max(1, Math.min(opts.minBars ?? DEFAULT_MIN_BARS, maxBars))
  const windowBars = minBars + Math.floor(rand() * (maxBars - minBars + 1))
  const offsetBars = Math.floor(rand() * (totalBars - windowBars + 1))
  const start = bounds.earliest + offsetBars * intervalSec
  return { start, end: start + windowBars * intervalSec }
}
