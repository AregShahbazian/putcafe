import { test, expect } from "@playwright/test"

/** Drives each indicator algo end-to-end through `window.pc` (no UI clicks).
 * Network-dependent: needs Binance klines and the bot `/api/bot/futures/run`
 * (VITE_API_BASE / proxy → local bot). Fixed history → deterministic. Each algo
 * runs on the shared futures engine, so the same sim invariants (`pc.verify`)
 * and chart price-lines apply. */

// 2024-01-01 → 2024-01-21 UTC, BTCUSDT 1h (480 candles).
const RANGE = { start: 1704067200, end: 1705795200 }

const ALGOS = ["ma_cross", "rsi_revert", "bollinger", "donchian", "macd"] as const

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window { pc: any }
}

test("every indicator algo runs a headless backtest with valid sim invariants", async ({ page }) => {
  await page.goto("/")
  await page.waitForFunction(() => "pc" in window)
  await page.evaluate(() => window.pc.ready)

  for (const algo of ALGOS) {
    const run = await page.evaluate(
      ({ algo, start, end }) => window.pc.session.start({ algo, mode: "headless", start, end }),
      { algo, ...RANGE },
    )
    expect(run.status, `${algo} finishes`).toBe("finished")
    expect(run.sim, `${algo} produced a sim`).not.toBeNull()

    const verdict = await page.evaluate(() => window.pc.verify())
    expect(verdict, `${algo} sim invariants`).toMatchObject({ ok: true, kind: "sim", mismatches: [] })

    await page.evaluate(() => window.pc.session.stop())
  }
})

test("donchian replay draws entry marker + TP/SL bracket at the first trade", async ({ page }) => {
  await page.goto("/")
  await page.waitForFunction(() => "pc" in window)
  await page.evaluate(() => window.pc.ready)

  const head = await page.evaluate(
    ({ start, end }) =>
      window.pc.session.start({ algo: "donchian", mode: "headless", start, end, algoParams: { period: 20 } }),
    RANGE,
  )
  expect(head.sim.tradeCount).toBeGreaterThan(0)

  await page.evaluate(
    ({ start, end }) =>
      window.pc.session.start({ algo: "donchian", mode: "replay", start, end, algoParams: { period: 20 } }),
    RANGE,
  )
  const trades = await page.evaluate(() => window.pc.state.trades())
  const first = trades[0]
  await page.evaluate(() => window.pc.setSpeed(20))
  const at = await page.evaluate(t => window.pc.playTo(t), first.entryTime)
  expect(at.cursorTime).toBe(first.entryTime)

  const markers = await page.evaluate(() => window.pc.chart.markers())
  expect(markers.some((m: { time: number }) => m.time === first.entryTime)).toBe(true)
  const lines: { title: string }[] = await page.evaluate(() => window.pc.chart.priceLines())
  expect(lines.some(l => l.title.startsWith("SL"))).toBe(true)
  expect(lines.some(l => l.title.startsWith("TP"))).toBe(true)

  await page.evaluate(() => window.pc.session.stop())
})
