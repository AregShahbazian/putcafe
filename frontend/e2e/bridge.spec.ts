import { test, expect } from "@playwright/test"

/** Living documentation for `window.pc` — drives a full scenario through the
 * console bridge only (no UI clicks). Network-dependent: needs Binance klines
 * and the positions/bot backend (`VITE_API_BASE`). The range is fixed history,
 * so the pivot sim is deterministic run-to-run. */

// 2024-01-01 → 2024-01-21 UTC, BTCUSDT 1h (480 candles).
const RANGE = { start: 1704067200, end: 1705795200 }

declare global {
  // The bridge is intentionally untyped on the test side (it's a console API).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window { pc: any }
}

test("console bridge drives a pivot backtest end-to-end", async ({ page }) => {
  await page.goto("/")
  await page.waitForFunction(() => "pc" in window)
  await page.evaluate(() => window.pc.ready)

  // Headless run: resolves only when finished; sim invariants must hold.
  const headless = await page.evaluate(
    ({ start, end }) => window.pc.session.start({ algo: "pivot", mode: "headless", start, end }),
    RANGE,
  )
  expect(headless.status).toBe("finished")
  expect(headless.sim.tradeCount).toBeGreaterThan(0)
  const verdict = await page.evaluate(() => window.pc.verify())
  expect(verdict).toMatchObject({ ok: true, kind: "sim", mismatches: [] })

  // Replay the same range and play to the first entry candle. Speed 20 steps
  // one candle per tick, so playTo lands exactly on the target.
  await page.evaluate(
    ({ start, end }) => window.pc.session.start({ algo: "pivot", mode: "replay", start, end }),
    RANGE,
  )
  const trades = await page.evaluate(() => window.pc.state.trades())
  const first = trades[0]
  await page.evaluate(() => window.pc.setSpeed(20))
  const at = await page.evaluate(t => window.pc.playTo(t), first.entryTime)
  expect(at.status).toBe("paused")
  expect(at.cursorTime).toBe(first.entryTime)

  // The chart actually drew it: entry marker present, bracket lines up.
  const markers = await page.evaluate(() => window.pc.chart.markers())
  expect(markers.some((m: { time: number }) => m.time === first.entryTime)).toBe(true)
  // Titles by prefix only — their detail text (qty/price/%) is free to evolve.
  const lines: { title: string }[] = await page.evaluate(() => window.pc.chart.priceLines())
  expect(lines).toHaveLength(3)
  expect(lines.some(l => l.title.startsWith("SL"))).toBe(true)
  expect(lines.some(l => l.title.startsWith("TP"))).toBe(true)
  expect(lines.some(l => new RegExp(`^(entry ${first.side}|${first.side})`, "i").test(l.title))).toBe(true)

  // Rendered candles stop at the cursor — render matches engine state.
  const rendered = await page.evaluate(() => window.pc.chart.renderedCandles())
  expect(rendered.lastTime).toBe(first.entryTime)

  const stopped = await page.evaluate(() => window.pc.session.stop())
  expect(stopped.status).toBe("idle")
})
