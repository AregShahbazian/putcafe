import { fetchKlines, fetchKlinesRange, type Candle } from "../binance/api"
import {
  bot,
  positions,
  type FuturesParams,
  type FuturesSnapshot,
  type Pivot,
  type PivotOptions,
  type Session,
  type SessionConfig,
} from "../api/backend"
import { DEFAULT_PIVOT_OPTIONS } from "../util/pivotOptions"

export type EngineStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "finished"

export interface EngineSnapshot {
  status: EngineStatus
  mode: "replay" | "headless" | null
  candles: Candle[] // full session range
  preCandles: Candle[] // pre-start history, rendered as chart context
  upTo: number // rendered candle count (within candles)
  pivots: Pivot[]
  sim: FuturesSnapshot | null // the engine snapshot — every algo
  session: Session | null // persisted session metadata
  speed: number // candles per second
  autoResume: boolean
  progress: number // headless 0..1
  error: string | null
}

export const SPEEDS = [1, 2, 5, 10, 20, 100]
const SEED_HISTORY = 500 // candles of pre-start chart context

const idleSnapshot = (): EngineSnapshot => ({
  status: "idle",
  mode: null,
  candles: [],
  preCandles: [],
  upTo: 0,
  pivots: [],
  sim: null,
  session: null,
  speed: 10,
  autoResume: false,
  progress: 0,
  error: null,
})

/** One engine, one path. Every algo is a stateless futures backtest: the bot
 * computes the whole snapshot up front; replay reveals it by advancing the
 * cursor (step-back is render-only). The session (config + snapshot) is
 * persisted so it survives reload. Live-tuning re-runs the snapshot. */
export class BacktestEngine {
  private snap = idleSnapshot()
  private config: SessionConfig | null = null
  private pivotOptions: PivotOptions = DEFAULT_PIVOT_OPTIONS
  private seedHistory: Candle[] = []
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
    this.emit({ ...idleSnapshot(), status: "loading", mode: config.mode, speed: this.snap.speed, autoResume: this.snap.autoResume })
    try {
      const candles = await fetchKlinesRange(config.market, config.interval, config.startTime, config.endTime)
      if (candles.length === 0) throw new Error("no candles in the selected range")
      this.seedHistory = (await fetchKlines(config.market, config.interval, config.startTime * 1000 - 1)).slice(-SEED_HISTORY)
      const sim = await this.runSim(candles)
      if (this.aborted) return
      // Persist the session (config + full snapshot) so it lists + survives reload.
      const session = await positions
        .createSession({ ...config, leverage: config.params.leverage, snapshot: sim })
        .catch(() => null)
      if (this.aborted) return
      this.snap = {
        ...this.snap,
        status: "ready",
        candles,
        preCandles: this.seedHistory,
        upTo: 1,
        pivots: sim.pivots ?? [],
        sim,
        session,
        progress: 0,
      }
      if (config.mode === "headless") {
        this.snap = { ...this.snap, upTo: candles.length, status: "finished", progress: 1 }
        if (session) await positions.finish(session.id).catch(() => {})
      }
      this.onChange(this.snap)
    } catch (e) {
      this.emit({ status: "idle", mode: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  private runSim(candles: Candle[]): Promise<FuturesSnapshot> {
    const cfg = this.config!
    return bot.run(candles, cfg.algo, this.pivotOptions, {
      ...cfg.params,
      feesEnabled: cfg.feesEnabled,
      startingBalance: cfg.startingBalance,
    })
  }

  /** Advance one candle. Significant (pauses playback) when the snapshot has an
   * event on this candle — an open/add/exit/liquidation. */
  private stepOnce(render: boolean): boolean {
    const { candles, sim } = this.snap
    if (this.snap.upTo >= candles.length) return false
    const candle = candles[this.snap.upTo]
    const significant = sim?.events.some(e => e.time === candle.time) ?? false
    this.snap = { ...this.snap, upTo: this.snap.upTo + 1 }
    if (render) this.onChange(this.snap)
    return significant
  }

  play() {
    if (this.snap.status !== "ready" && this.snap.status !== "paused") return
    this.emit({ status: "playing" })
    const tick = () => {
      if (this.snap.status !== "playing" || this.busy) {
        if (this.snap.status === "playing") this.timer = setTimeout(tick, 50)
        return
      }
      this.busy = true
      try {
        const batch = this.snap.speed >= 100 ? Math.round(this.snap.speed / 10) : 1
        const delay = this.snap.speed >= 100 ? 100 : 1000 / this.snap.speed
        let pause = false
        for (let i = 0; i < batch && this.snap.upTo < this.snap.candles.length; i++) {
          const significant = this.stepOnce(true)
          if (significant && !this.snap.autoResume) {
            pause = true
            break
          }
        }
        if (this.snap.upTo >= this.snap.candles.length) {
          void this.finishSession()
        } else if (pause) {
          this.emit({ status: "paused" })
        } else if (this.snap.status === "playing") {
          this.timer = setTimeout(tick, delay)
        }
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

  stepForward() {
    if (this.busy || (this.snap.status !== "ready" && this.snap.status !== "paused")) return
    this.stepOnce(true)
    if (this.snap.upTo >= this.snap.candles.length) void this.finishSession()
  }

  /** Render-only rewind — the snapshot is pre-computed, so nothing re-runs. */
  stepBack() {
    if (this.snap.mode !== "replay" || this.snap.upTo <= 1) return
    if (this.snap.status === "playing") this.pause()
    this.emit({ upTo: this.snap.upTo - 1, status: this.snap.status === "finished" ? "paused" : this.snap.status })
  }

  /** Fresh session from the same config (the old persisted row is deleted). */
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
    if (s && s.status === "active") await positions.finish(s.id).catch(() => {})
    this.emit({ ...idleSnapshot(), speed: this.snap.speed, autoResume: this.snap.autoResume })
  }

  /** Load a persisted (finished) session back onto the chart from its snapshot. */
  async loadSession(id: string) {
    this.stopTimer()
    this.aborted = false
    this.config = null
    this.emit({ ...idleSnapshot(), status: "loading", speed: this.snap.speed, autoResume: this.snap.autoResume })
    try {
      const detail = await positions.getSession(id)
      const candles = await fetchKlinesRange(detail.market, detail.interval, detail.startTime, detail.endTime)
      const pre = (await fetchKlines(detail.market, detail.interval, detail.startTime * 1000 - 1)).slice(-SEED_HISTORY)
      this.emit({
        status: "finished",
        mode: "headless", // render-results shape: no playback controls
        candles,
        preCandles: pre,
        upTo: candles.length,
        pivots: detail.snapshot.pivots ?? [],
        sim: detail.snapshot,
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
    if (s && s.status === "active") await positions.finish(s.id).catch(() => {})
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

  /** Live control: changing pivot options re-runs the whole snapshot over the
   * same range (cursor stays put; trades/orders/positions update). */
  async setPivotOptions(options: PivotOptions) {
    this.pivotOptions = options
    return this.resimulate()
  }

  /** Live control: changing params (TP/SL ratio, SL, size, leverage, cadence)
   * re-runs the snapshot. */
  async setParams(params: FuturesParams) {
    if (!this.config) return
    this.config = { ...this.config, params }
    return this.resimulate()
  }

  private async resimulate() {
    const { status, candles } = this.snap
    if (!this.config || candles.length === 0) return
    if (!["ready", "playing", "paused", "finished"].includes(status)) return
    try {
      const sim = await this.runSim(candles)
      if (this.aborted) return
      this.emit({ sim, pivots: sim.pivots ?? [] })
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
