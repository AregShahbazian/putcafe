import { fetchKlines, fetchKlinesRange, type Candle } from "../binance/api"
import { bot, positions, type Pivot, type PivotOptions, type Session, type SessionConfig, type Trade } from "../api/backend"
import { DEFAULT_PIVOT_OPTIONS } from "../util/pivotOptions"

export type EngineStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "finished"

export interface EngineSnapshot {
  status: EngineStatus
  mode: "replay" | "headless" | null
  candles: Candle[] // full session range
  preCandles: Candle[] // pre-start history, rendered as chart context
  upTo: number // rendered candle count (within candles)
  trades: Trade[]
  pivots: Pivot[]
  session: Session | null
  speed: number // candles per second
  autoResume: boolean
  progress: number // headless 0..1
  error: string | null
}

export const SPEEDS = [1, 2, 5, 10, 20, 100]
const SEED_HISTORY = 500 // candles of pre-start support data for the bot

const idleSnapshot = (): EngineSnapshot => ({
  status: "idle",
  mode: null,
  candles: [],
  preCandles: [],
  upTo: 0,
  trades: [],
  pivots: [],
  session: null,
  speed: 5,
  autoResume: true,
  progress: 0,
  error: null,
})

/** One engine, two modes. Replay: user-paced; pauses on significant events
 * (anything changing the position) unless auto-resume. Headless: runs the whole
 * range without per-step rendering. Trades persist server-side; stepBack is
 * render-only and bot/orders never re-run for already-processed candles. */
export class BacktestEngine {
  private snap = idleSnapshot()
  private config: SessionConfig | null = null
  private pivotOptions: PivotOptions = DEFAULT_PIVOT_OPTIONS
  private seedHistory: Candle[] = []
  private processedUpTo = 0 // candles already sent through bot/orders
  private timer: ReturnType<typeof setTimeout> | null = null
  private busy = false
  private aborted = false

  constructor(private onChange: (s: EngineSnapshot) => void) {}

  private emit(patch: Partial<EngineSnapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.onChange(this.snap)
  }

  get snapshot() {
    return this.snap
  }

  async start(config: SessionConfig) {
    this.stopTimer()
    this.aborted = false
    this.config = config
    this.processedUpTo = 0
    this.emit({ ...idleSnapshot(), status: "loading", mode: config.mode, speed: this.snap.speed, autoResume: this.snap.autoResume })
    try {
      const candles = await fetchKlinesRange(config.market, config.interval, config.startTime, config.endTime)
      if (candles.length === 0) throw new Error("no candles in the selected range")
      this.seedHistory = await fetchKlines(config.market, config.interval, config.startTime * 1000 - 1)
      this.seedHistory = this.seedHistory.slice(-SEED_HISTORY)
      const session = await positions.createSession(config)
      const seeded = await bot.seed(session.id, {
        algo: config.algo,
        config: config.algoConfig,
        candles: this.seedHistory,
        options: this.pivotOptions,
      })
      if (this.aborted) return
      this.emit({
        status: "ready",
        candles,
        preCandles: this.seedHistory,
        upTo: 1,
        trades: [],
        pivots: seeded.pivots ?? [],
        session,
        progress: 0,
      })
      this.processedUpTo = 1 // the first candle is shown as the starting point, not traded
      if (config.mode === "headless") await this.runHeadless()
    } catch (e) {
      this.emit({ status: "idle", mode: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Advance one candle. Returns true when a significant event occurred. */
  private async stepOnce(render: boolean): Promise<boolean> {
    const { candles, session } = this.snap
    if (!session || this.snap.upTo >= candles.length) return false
    const idx = this.snap.upTo
    const candle = candles[idx]
    let significant = false

    if (idx >= this.processedUpTo) {
      const { decisions, pivots } = await this.botStep(session.id, candle)
      if (pivots !== null) this.snap = { ...this.snap, pivots }
      for (const d of decisions) {
        try {
          const res = await positions.order(session.id, {
            time: candle.time,
            side: d.side,
            quoteAmount: d.quoteAmount,
            price: candle.close,
          })
          significant = true
          this.snap = {
            ...this.snap,
            trades: [...this.snap.trades, res.trade],
            session: { ...session, ...res, id: session.id },
          }
        } catch (e) {
          // insufficient balance (409) — not significant, keep going
          if ((e as { status?: number }).status !== 409) throw e
        }
      }
      this.processedUpTo = idx + 1
    }

    this.snap = { ...this.snap, upTo: idx + 1 }
    if (render) this.onChange(this.snap)
    return significant
  }

  /** Bot step with one re-seed retry (bot restarts lose in-memory support data). */
  private async botStep(sessionId: string, candle: Candle) {
    try {
      return await bot.step(sessionId, candle)
    } catch (e) {
      if ((e as { status?: number }).status !== 409 || !this.config) throw e
      await this.reseed(sessionId)
      return await bot.step(sessionId, candle)
    }
  }

  private async reseed(sessionId: string) {
    if (!this.config) return
    const processed = this.snap.candles.slice(0, this.snap.upTo)
    await bot.seed(sessionId, {
      algo: this.config.algo,
      config: this.config.algoConfig,
      candles: [...this.seedHistory, ...processed],
      options: this.pivotOptions,
    })
  }

  /** Headless runs entirely server-side in one call (bot loops in Python, hits
   * positions only on fills). The frontend just refetches the final state. */
  private async runHeadless() {
    const session = this.snap.session
    if (!session) return
    this.emit({ status: "playing", progress: 0 })
    try {
      const result = await bot.run(session.id, this.snap.candles)
      if (this.aborted) return
      const detail = await positions.getSession(session.id)
      this.processedUpTo = this.snap.candles.length
      this.snap = {
        ...this.snap,
        trades: detail.trades,
        pivots: result.pivots ?? this.snap.pivots,
        session: detail,
        upTo: this.snap.candles.length,
      }
      await this.finishSession()
    } catch (e) {
      this.emit({ status: "paused", error: e instanceof Error ? e.message : String(e) })
    }
  }

  play() {
    if (this.snap.status !== "ready" && this.snap.status !== "paused") return
    this.emit({ status: "playing" })
    const tick = async () => {
      if (this.snap.status !== "playing" || this.busy) {
        if (this.snap.status === "playing") this.timer = setTimeout(tick, 50)
        return
      }
      this.busy = true
      try {
        // ≥100 cps batches steps per tick to stay responsive.
        const batch = this.snap.speed >= 100 ? Math.round(this.snap.speed / 10) : 1
        const delay = this.snap.speed >= 100 ? 100 : 1000 / this.snap.speed
        let pause = false
        for (let i = 0; i < batch && this.snap.upTo < this.snap.candles.length; i++) {
          const significant = await this.stepOnce(true)
          if (significant && !this.snap.autoResume) {
            pause = true
            break
          }
        }
        if (this.snap.upTo >= this.snap.candles.length) {
          await this.finishSession()
        } else if (pause) {
          this.emit({ status: "paused" })
        } else if (this.snap.status === "playing") {
          this.timer = setTimeout(tick, delay)
        }
      } catch (e) {
        this.emit({ status: "paused", error: e instanceof Error ? e.message : String(e) })
      } finally {
        this.busy = false
      }
    }
    this.timer = setTimeout(tick, 0)
  }

  pause() {
    if (this.snap.status === "playing" && this.snap.mode === "replay") {
      this.stopTimer()
      this.emit({ status: "paused" })
    }
  }

  async stepForward() {
    if (this.busy || (this.snap.status !== "ready" && this.snap.status !== "paused")) return
    this.busy = true
    try {
      await this.stepOnce(true)
      if (this.snap.upTo >= this.snap.candles.length) await this.finishSession()
    } catch (e) {
      this.emit({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      this.busy = false
    }
  }

  /** Render-only rewind — server-side trades are not undone. */
  stepBack() {
    if (this.snap.mode !== "replay" || this.snap.upTo <= 1) return
    if (this.snap.status === "playing") this.pause()
    this.emit({ upTo: this.snap.upTo - 1, status: this.snap.status === "finished" ? "paused" : this.snap.status })
  }

  /** Fresh session from the same config (old one is deleted — trades live server-side). */
  async restart() {
    if (!this.config) return
    const old = this.snap.session
    this.stopTimer()
    if (old) await positions.remove(old.id).catch(() => {})
    await this.start(this.config)
  }

  /** Exit — finishes an active session and returns the chart to live mode. */
  async stop() {
    this.aborted = true
    this.stopTimer()
    const s = this.snap.session
    if (s && this.snap.session?.status === "active") await positions.finish(s.id).catch(() => {})
    this.emit({ ...idleSnapshot(), speed: this.snap.speed, autoResume: this.snap.autoResume })
  }

  /** Load a persisted (finished) session back onto the chart. */
  async loadSession(id: string) {
    this.stopTimer()
    this.aborted = false
    this.config = null
    this.emit({ ...idleSnapshot(), status: "loading", speed: this.snap.speed, autoResume: this.snap.autoResume })
    try {
      const detail = await positions.getSession(id)
      const candles = await fetchKlinesRange(detail.market, detail.interval, detail.startTime, detail.endTime)
      const pre = (await fetchKlines(detail.market, detail.interval, detail.startTime * 1000 - 1)).slice(-SEED_HISTORY)
      // The bot's in-memory session is gone for persisted sessions — analyze statelessly.
      const pivots = this.pivotOptions.enabled
        ? ((await bot.analyze([...pre, ...candles], this.pivotOptions).catch(() => null))?.pivots ?? [])
        : []
      this.emit({
        status: "finished",
        mode: "headless", // render-results shape: no playback controls
        candles,
        preCandles: pre,
        upTo: candles.length,
        trades: detail.trades,
        pivots,
        session: detail,
        progress: 1,
      })
    } catch (e) {
      this.emit({ status: "idle", error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async finishSession() {
    const s = this.snap.session
    this.stopTimer()
    if (s) await positions.finish(s.id).catch(() => {})
    this.emit({
      status: "finished",
      progress: 1,
      session: s ? { ...s, status: "finished" } : null,
      upTo: this.snap.candles.length,
    })
  }

  setSpeed(speed: number) {
    this.emit({ speed })
  }

  /** Live control: persists as the engine's current options; mid-replay the bot
   * recomputes over the candles it has seen, finished/loaded views re-analyze. */
  async setPivotOptions(options: PivotOptions) {
    this.pivotOptions = options
    const { session, status, mode } = this.snap
    if (!options.enabled) {
      if (this.snap.pivots.length > 0) this.emit({ pivots: [] })
      return
    }
    try {
      if (session && mode === "replay" && (status === "ready" || status === "playing" || status === "paused")) {
        let res
        try {
          res = await bot.setOptions(session.id, options)
        } catch (e) {
          if ((e as { status?: number }).status !== 409 || !this.config) throw e
          await this.reseed(session.id)
          res = await bot.setOptions(session.id, options)
        }
        this.emit({ pivots: res.pivots ?? [] })
      } else if (status === "finished") {
        const candles = [...this.snap.preCandles, ...this.snap.candles]
        if (candles.length === 0) return
        const res = await bot.analyze(candles, options)
        this.emit({ pivots: res.pivots ?? [] })
      }
    } catch (e) {
      this.emit({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  setAutoResume(autoResume: boolean) {
    this.emit({ autoResume })
  }

  clearError() {
    this.emit({ error: null })
  }

  private stopTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
