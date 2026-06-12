import type { BacktestEngine, EngineSnapshot } from "../backtest/engine"
import { positions, type PivotOptions, type Session } from "../api/backend"
import { INTERVAL_SECONDS, type Candle, type Market } from "../binance/api"
import type { Interval } from "../components/TimeframeSelector"
import type { PanelConfig } from "../components/BacktestPanel"
import type { RangeSelection } from "../chart/RangeHighlight"
import type { PivotMark } from "../chart/PivotMarkers"

/** `window.pc` — the console bridge. Every command returns a Promise of plain
 * JSON-serializable data, so it works from DevTools and from Playwright's
 * `page.evaluate` alike. React components contribute capability handles
 * (registered once per mount, reading refs at call time); the engine is tapped
 * for snapshots, from which the event log and the waiters are derived. */

// ---------------------------------------------------------------- errors

class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`)
  }
}

const err = (code: string, message: string) => new BridgeError(code, message)

// ---------------------------------------------------------------- handles

export interface UiState {
  market: Market
  interval: Interval
  config: PanelConfig
  pivotOptions: PivotOptions
  rangeStart?: number
  rangeEnd?: number
  presets: string[]
}

/** Session-start overrides; anything omitted defaults from current UI state. */
export interface SessionOverrides {
  market?: string
  interval?: Interval
  start?: number
  end?: number
  mode?: "replay" | "headless"
  algo?: "dca" | "pivot"
  quoteAmount?: number
  frequencySec?: number
  startingBalance?: number
  feesEnabled?: boolean
  tpSlRatio?: number
  slCapPct?: number
  positionSize?: number
}

export interface AppHandle {
  getUi(): UiState
  /** Must drive the same code path the Start button does AND sync visible UI
   * state (market/interval/range/config) so bridge and UI never diverge. */
  startSession(overrides: SessionOverrides): void
  stopSession(): Promise<void>
  loadPreset(name: string): void
  loadSession(id: string): void
}

export interface RenderedMarker {
  time: number
  position: string
  shape: string
  color: string
  text?: string
}

export interface ChartHandle {
  visibleRange(): { from: number | null; to: number | null }
  markers(): RenderedMarker[]
  pivotShapes(): PivotMark[]
  priceLines(): { price: number; title: string; color: string }[]
  rangeHighlight(): RangeSelection
  renderedCandles(): { count: number; firstTime: number | null; lastTime: number | null }
}

// ---------------------------------------------------------------- registry

let engine: BacktestEngine | null = null
let appHandle: AppHandle | null = null
let chartHandle: ChartHandle | null = null
let latest: EngineSnapshot | null = null

let readyResolve: () => void = () => {}
const ready = new Promise<void>(r => (readyResolve = r))
const maybeReady = () => {
  if (engine && appHandle && chartHandle) readyResolve()
}

export function registerAppHandle(h: AppHandle): () => void {
  appHandle = h
  maybeReady()
  return () => {
    if (appHandle === h) appHandle = null
  }
}

export function registerChartHandle(h: ChartHandle): () => void {
  chartHandle = h
  maybeReady()
  return () => {
    if (chartHandle === h) chartHandle = null
  }
}

const requireEngine = () => {
  if (!engine) throw err("not-ready", "bridge not installed yet — await pc.ready")
  return engine
}
const requireApp = () => {
  if (!appHandle) throw err("not-ready", "app not mounted yet — await pc.ready")
  return appHandle
}
const requireChart = () => {
  if (!chartHandle) throw err("not-ready", "chart not mounted yet — await pc.ready")
  return chartHandle
}

const snap = (): EngineSnapshot => latest ?? requireEngine().snapshot

// ---------------------------------------------------------------- events

export interface BridgeEvent {
  seq: number
  at: number // epoch ms
  type: "status" | "trade" | "pivots" | "error" | "call"
  data: Record<string, unknown>
}

const EVENT_CAP = 500
const eventLog: BridgeEvent[] = []
let eventSeq = 0
const eventSubs = new Set<(e: BridgeEvent) => void>()
const snapshotSubs = new Set<(s: EngineSnapshot) => void>()

function pushEvent(type: BridgeEvent["type"], data: Record<string, unknown>) {
  const e: BridgeEvent = { seq: ++eventSeq, at: Date.now(), type, data }
  eventLog.push(e)
  if (eventLog.length > EVENT_CAP) eventLog.splice(0, eventLog.length - EVENT_CAP)
  for (const sub of [...eventSubs]) sub(e)
}

/** Engine snapshot tap (wired into the engine's onChange in App). Diffs
 * consecutive snapshots into the event log, then notifies waiters. */
export function bridgeSnapshot(s: EngineSnapshot) {
  const prev = latest
  latest = s
  if (prev) {
    if (s.status !== prev.status)
      pushEvent("status", { from: prev.status, to: s.status, cursorTime: cursorTime(s) })
    if (s.error && s.error !== prev.error) pushEvent("error", { message: s.error })
    // DCA trades append to the snapshot as they fill.
    for (let i = prev.trades.length; i < s.trades.length; i++)
      pushEvent("trade", { kind: "dca", trade: s.trades[i] })
    // Pivot-sim trades are pre-computed; they "happen" as the cursor passes
    // their entry/exit candle.
    if (s.pivotSim && prev.candles === s.candles && s.upTo > prev.upTo) {
      const passed = new Set(s.candles.slice(prev.upTo, s.upTo).map(c => c.time))
      for (const t of s.pivotSim.trades) {
        if (passed.has(t.entryTime))
          pushEvent("trade", { kind: "pivot", phase: "entry", side: t.side, time: t.entryTime, price: t.entryPrice })
        if (t.exitTime !== null && passed.has(t.exitTime))
          pushEvent("trade", { kind: "pivot", phase: "exit", side: t.side, time: t.exitTime, price: t.exitPrice, reason: t.exitReason })
      }
    }
    if (s.pivots.length !== prev.pivots.length) pushEvent("pivots", { count: s.pivots.length })
  }
  for (const sub of [...snapshotSubs]) sub(s)
}

// ---------------------------------------------------------------- helpers

/** Times are accepted in unix seconds or milliseconds. */
const normTime = (t: number) => (t > 1e12 ? Math.floor(t / 1000) : t)

const cursorTime = (s: EngineSnapshot): number | null =>
  s.upTo > 0 && s.candles.length > 0 ? s.candles[Math.min(s.upTo, s.candles.length) - 1].time : null

export interface SnapshotSummary {
  status: EngineSnapshot["status"]
  mode: EngineSnapshot["mode"]
  candleCount: number
  preCandleCount: number
  upTo: number
  cursorTime: number | null
  tradeCount: number
  pivotCount: number
  speed: number
  autoResume: boolean
  progress: number
  error: string | null
  session: Pick<Session, "id" | "status" | "quoteBalance" | "baseQty" | "avgEntry" | "feesPaid"> | null
  sim: { equity: number; realizedPnl: number; wins: number; losses: number; tradeCount: number; open: boolean } | null
}

function summary(s: EngineSnapshot = snap()): SnapshotSummary {
  const sess = s.session
  return {
    status: s.status,
    mode: s.mode,
    candleCount: s.candles.length,
    preCandleCount: s.preCandles.length,
    upTo: s.upTo,
    cursorTime: cursorTime(s),
    tradeCount: s.pivotSim ? s.pivotSim.trades.length : s.trades.length,
    pivotCount: s.pivots.length,
    speed: s.speed,
    autoResume: s.autoResume,
    progress: s.progress,
    error: s.error,
    session: sess
      ? {
          id: sess.id,
          status: sess.status,
          quoteBalance: sess.quoteBalance,
          baseQty: sess.baseQty,
          avgEntry: sess.avgEntry,
          feesPaid: sess.feesPaid,
        }
      : null,
    sim: s.pivotSim
      ? {
          equity: s.pivotSim.equity,
          realizedPnl: s.pivotSim.realizedPnl,
          wins: s.pivotSim.wins,
          losses: s.pivotSim.losses,
          tradeCount: s.pivotSim.trades.length,
          open: s.pivotSim.trades.some(t => t.exitReason === "open"),
        }
      : null,
  }
}

interface WaitOpts {
  timeoutMs?: number
}

/** Resolve when the predicate returns a value (checked immediately, then on
 * every snapshot). The predicate may throw to reject. */
function waitSnapshot<T>(pred: (s: EngineSnapshot) => T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      snapshotSubs.delete(sub)
      clearTimeout(timer)
      fn()
    }
    const check = (s: EngineSnapshot) => {
      try {
        const v = pred(s)
        if (v !== undefined) finish(() => resolve(v))
      } catch (e) {
        finish(() => reject(e))
      }
    }
    const sub = (s: EngineSnapshot) => check(s)
    const timer = setTimeout(
      () => finish(() => reject(err("timeout", `timed out after ${timeoutMs}ms waiting for ${what}`))),
      timeoutMs,
    )
    snapshotSubs.add(sub)
    if (latest) check(latest)
  })
}

function waitEvent(pred: (e: BridgeEvent) => boolean, what: string, timeoutMs = 30_000): Promise<BridgeEvent> {
  return new Promise<BridgeEvent>((resolve, reject) => {
    const sub = (e: BridgeEvent) => {
      if (!pred(e)) return
      eventSubs.delete(sub)
      clearTimeout(timer)
      resolve(e)
    }
    const timer = setTimeout(() => {
      eventSubs.delete(sub)
      reject(err("timeout", `timed out after ${timeoutMs}ms waiting for ${what}`))
    }, timeoutMs)
    eventSubs.add(sub)
  })
}

/** Wrap a command: logs a `call` event, logs failures as `error` events. */
function cmd<A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    pushEvent("call", { method: name, args })
    try {
      return await fn(...args)
    } catch (e) {
      pushEvent("error", { method: name, message: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }
}

// ---------------------------------------------------------------- actions

async function sessionStart(overrides: SessionOverrides = {}, opts: WaitOpts = {}): Promise<SnapshotSummary> {
  const app = requireApp()
  const ui = app.getUi()
  const o: SessionOverrides = { ...overrides }
  if (o.start !== undefined) o.start = normTime(o.start)
  if (o.end !== undefined) o.end = normTime(o.end)
  const start = o.start ?? ui.rangeStart
  const end = o.end ?? ui.rangeEnd
  if (start === undefined || end === undefined)
    throw err("bad-args", "start and end are required (no range picked in the UI to default from)")
  if (start >= end) throw err("bad-args", `start (${start}) must be before end (${end})`)
  if (o.interval !== undefined && !(o.interval in INTERVAL_SECONDS))
    throw err("bad-args", `unknown interval "${o.interval}" (${Object.keys(INTERVAL_SECONDS).join(", ")})`)
  const mode = o.mode ?? ui.config.mode
  // UI-equivalent: an active session is stopped before a new one starts.
  if (!["idle", "finished"].includes(snap().status)) await requireEngine().stop()
  app.startSession({ ...o, start, end })
  const wanted = mode === "replay" ? "ready" : "finished"
  return waitSnapshot(
    s => {
      if (s.error && (s.status === "idle" || s.status === "paused"))
        throw err("engine-error", s.error)
      return s.status === wanted ? summary(s) : undefined
    },
    `session "${wanted}"`,
    opts.timeoutMs ?? 120_000,
  )
}

async function sessionStop(opts: WaitOpts = {}): Promise<SnapshotSummary> {
  const e = requireEngine()
  if (snap().status === "idle") return summary()
  await e.stop()
  return waitSnapshot(s => (s.status === "idle" ? summary(s) : undefined), 'session "idle"', opts.timeoutMs ?? 15_000)
}

async function play(opts: WaitOpts = {}): Promise<SnapshotSummary> {
  const e = requireEngine()
  const st = snap().status
  if (st === "playing" || st === "finished") return summary()
  if (st !== "ready" && st !== "paused") throw err("bad-state", `cannot play from status "${st}"`)
  e.play()
  return waitSnapshot(
    s => (s.status === "playing" || s.status === "finished" ? summary(s) : undefined),
    "playback to start",
    opts.timeoutMs ?? 10_000,
  )
}

async function pause(opts: WaitOpts = {}): Promise<SnapshotSummary> {
  const e = requireEngine()
  const s = snap()
  if (s.status === "paused" || s.status === "ready" || s.status === "finished") return summary()
  if (s.status !== "playing" || s.mode !== "replay")
    throw err("bad-state", `cannot pause from status "${s.status}" (mode ${s.mode})`)
  e.pause()
  return waitSnapshot(p => (p.status !== "playing" ? summary(p) : undefined), "pause", opts.timeoutMs ?? 10_000)
}

async function stepForward(): Promise<SnapshotSummary> {
  const e = requireEngine()
  const st = snap().status
  if (st !== "ready" && st !== "paused") throw err("bad-state", `cannot step from status "${st}"`)
  await e.stepForward()
  return summary()
}

async function stepBack(): Promise<SnapshotSummary> {
  const e = requireEngine()
  const s = snap()
  if (s.mode !== "replay" || s.upTo <= 1) throw err("bad-state", "stepBack needs an active replay past its first candle")
  e.stepBack()
  return summary()
}

async function restart(opts: WaitOpts = {}): Promise<SnapshotSummary> {
  const e = requireEngine()
  const before = snap()
  if (before.status === "idle" || before.status === "loading") throw err("bad-state", "nothing to restart")
  const wanted = before.mode === "replay" ? "ready" : "finished"
  void e.restart()
  // Two-stage: first see the restart's own "loading", only then accept the
  // target status — otherwise the stale pre-restart snapshot resolves early.
  let restarted = false
  return waitSnapshot(
    s => {
      if (!restarted) {
        if (s.status === "loading") restarted = true
        return undefined
      }
      if (s.error && s.status === "idle") throw err("engine-error", s.error)
      return s.status === wanted ? summary(s) : undefined
    },
    `restart to "${wanted}"`,
    opts.timeoutMs ?? 120_000,
  )
}

async function setSpeed(speed: number): Promise<SnapshotSummary> {
  if (!Number.isFinite(speed) || speed <= 0) throw err("bad-args", `speed must be a positive number, got ${speed}`)
  requireEngine().setSpeed(speed)
  return summary()
}

async function setAutoResume(autoResume: boolean): Promise<SnapshotSummary> {
  requireEngine().setAutoResume(Boolean(autoResume))
  return summary()
}

/** Play until the cursor reaches candle time `t`, then pause there. Re-issues
 * play() across significant-event pauses (autoResume off). Resolves early if
 * the session finishes first. Note: speeds ≥100 batch candles per tick and can
 * overshoot the target by a few candles. */
function playTo(t: number, opts: WaitOpts = {}): Promise<SnapshotSummary> {
  const e = requireEngine()
  const target = normTime(t)
  const s = snap()
  if (!["ready", "paused", "playing", "finished"].includes(s.status))
    throw err("bad-state", `cannot playTo from status "${s.status}"`)
  const cur = cursorTime(s)
  if (s.status === "finished" || (cur !== null && cur >= target)) {
    if (s.status === "playing") e.pause()
    return Promise.resolve(summary())
  }
  const wait = waitSnapshot(
    p => {
      if (p.error && p.status === "idle") throw err("engine-error", p.error)
      const c = cursorTime(p)
      if (c !== null && c >= target) {
        e.pause()
        return summary()
      }
      if (p.status === "finished") return summary(p)
      // Re-arm across event pauses; microtask so we don't re-enter the notify loop.
      if (p.status === "paused") queueMicrotask(() => e.play())
      return undefined
    },
    `cursor to reach ${target}`,
    opts.timeoutMs ?? 120_000,
  )
  e.play()
  return wait
}

// ---------------------------------------------------------------- verify

interface Mismatch {
  field: string
  frontend: unknown
  backend: unknown
}

const near = (a: number | null | undefined, b: number | null | undefined) => {
  if (typeof a !== "number" || typeof b !== "number") return (a ?? null) === (b ?? null)
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-6)
}

/** Frontend↔backend cross-check for the active (or given) backend session;
 * internal invariant check for pivot sims (which have no backend session). */
async function verify(sessionId?: string): Promise<{ ok: boolean; kind: "sim" | "backend"; mismatches: Mismatch[] }> {
  const s = snap()
  const mismatches: Mismatch[] = []
  const mm = (field: string, frontend: unknown, backend: unknown) => mismatches.push({ field, frontend, backend })

  if (!sessionId && s.pivotSim) {
    const sim = s.pivotSim
    const closed = sim.trades.filter(t => t.exitReason !== "open")
    if (sim.wins + sim.losses !== closed.length) mm("sim.wins+losses = closed trades", sim.wins + sim.losses, closed.length)
    const startingBalance = requireApp().getUi().config.startingBalance
    if (!near(sim.equity, startingBalance + sim.realizedPnl))
      mm("sim.equity = startingBalance + realizedPnl", sim.equity, startingBalance + sim.realizedPnl)
    sim.trades.forEach((t, i) => {
      const ok =
        t.side === "long"
          ? t.slPrice < t.entryPrice && t.tpPrice > t.entryPrice
          : t.slPrice > t.entryPrice && t.tpPrice < t.entryPrice
      if (!ok) mm(`sim.trades[${i}].bracket sides (${t.side})`, { entry: t.entryPrice, sl: t.slPrice, tp: t.tpPrice }, "sl/tp on opposite sides of entry")
      if (t.exitTime !== null && t.exitTime < t.entryTime) mm(`sim.trades[${i}].exit before entry`, t.exitTime, t.entryTime)
    })
    return { ok: mismatches.length === 0, kind: "sim", mismatches }
  }

  const id = sessionId ?? s.session?.id
  if (!id) throw err("bad-state", "nothing to verify — no active backend session and no pivot sim")
  const detail = await positions.getSession(id)
  // Backend internal consistency (fill math from the positions service).
  const sumQuote = detail.trades.reduce((a, t) => a + t.quoteAmount, 0)
  const sumFee = detail.trades.reduce((a, t) => a + t.fee, 0)
  const sumBase = detail.trades.reduce((a, t) => a + t.baseQty, 0)
  const sumCost = detail.trades.reduce((a, t) => a + t.baseQty * t.price, 0)
  if (!near(detail.feesPaid, sumFee)) mm("backend.feesPaid = Σfee", detail.feesPaid, sumFee)
  if (!near(detail.baseQty, sumBase)) mm("backend.baseQty = ΣbaseQty", detail.baseQty, sumBase)
  if (!near(detail.quoteBalance, detail.startingBalance - sumQuote))
    mm("backend.quoteBalance = starting − Σquote", detail.quoteBalance, detail.startingBalance - sumQuote)
  if (sumBase > 0 && !near(detail.avgEntry, sumCost / sumBase))
    mm("backend.avgEntry = Σ(base·price)/Σbase", detail.avgEntry, sumCost / sumBase)
  // Frontend mirror vs backend, when the snapshot carries this very session.
  if (s.session?.id === id) {
    if (s.trades.length !== detail.trades.length) mm("trades.length", s.trades.length, detail.trades.length)
    if (!near(s.session.quoteBalance, detail.quoteBalance)) mm("quoteBalance", s.session.quoteBalance, detail.quoteBalance)
    if (!near(s.session.baseQty, detail.baseQty)) mm("baseQty", s.session.baseQty, detail.baseQty)
    if (!near(s.session.avgEntry, detail.avgEntry)) mm("avgEntry", s.session.avgEntry, detail.avgEntry)
    if (!near(s.session.feesPaid, detail.feesPaid)) mm("feesPaid", s.session.feesPaid, detail.feesPaid)
  }
  return { ok: mismatches.length === 0, kind: "backend", mismatches }
}

// ---------------------------------------------------------------- chart settle

/** The chart renders one React commit behind the engine. Chart getters first
 * wait for the drawn cursor to match the engine cursor, so what they return is
 * never a stale frame. (All session-derived chart refs — candles, markers,
 * price lines — update in the same commit, so candle equality covers them.) */
async function settled<T>(read: (c: ChartHandle) => T, timeoutMs = 5_000): Promise<T> {
  const startedAt = performance.now()
  for (;;) {
    const c = requireChart()
    const s = snap()
    const active = s.candles.length > 0 && ["ready", "playing", "paused", "finished"].includes(s.status)
    if (!active || c.renderedCandles().lastTime === cursorTime(s)) return read(c)
    if (performance.now() - startedAt > timeoutMs)
      throw err("timeout", `chart did not settle to the engine cursor within ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 16))
  }
}

// ---------------------------------------------------------------- dump

/** The original ad-hoc console dump — `pc()` / `pc(time)`. */
function dump(t?: number) {
  const s = snap()
  const ui = requireApp().getUi()
  const sim = s.pivotSim
  const norm = t === undefined ? undefined : normTime(t)
  const trades =
    sim && norm !== undefined ? sim.trades.filter(tr => tr.entryTime === norm || tr.exitTime === norm) : sim?.trades
  const out = {
    market: ui.market.symbol,
    interval: ui.interval,
    config: ui.config,
    pivotOptions: ui.pivotOptions,
    status: s.status,
    session: s.session,
    sim: sim && { equity: sim.equity, wins: sim.wins, losses: sim.losses, realizedPnl: sim.realizedPnl },
    trades,
  }
  // eslint-disable-next-line no-console
  console.log(out)
  return out
}

// ---------------------------------------------------------------- help

const COMMANDS: [string, string][] = [
  ["pc.ready", "promise — resolves once the app + chart are mounted and the bridge is wired"],
  ["pc.version", "bridge API version (bumped on breaking change)"],
  ["pc() / pc.dump(time?)", "dump live state; with a time, filter sim trades touching that candle"],
  ["pc.session.start({start, end, mode?, algo?, market?, interval?, …params}, {timeoutMs?})", "start a session (defaults from UI); resolves on ready (replay) / finished (headless)"],
  ["pc.session.stop()", "finish the active session, back to idle"],
  ["pc.session.loadPreset(name)", "load a saved preset into the UI (does not start it)"],
  ["pc.session.loadSession(id)", "load a persisted backend session onto the chart"],
  ["pc.play() / pc.pause() / pc.stepForward() / pc.stepBack() / pc.restart()", "playback controls; each resolves once the engine reflects it"],
  ["pc.setSpeed(cps) / pc.setAutoResume(bool)", "playback tuning"],
  ["pc.playTo(time, {timeoutMs?})", "play and pause when the cursor reaches that candle (≥100 cps may overshoot)"],
  ["pc.waitFor.status(status, {timeoutMs?})", "resolve when engine status matches"],
  ["pc.waitFor.time(time, {timeoutMs?})", "resolve when the cursor reaches a candle time"],
  ["pc.waitFor.finished({timeoutMs?})", "resolve when the session finishes"],
  ["pc.waitFor.trade({fromSeq?, timeoutMs?})", "resolve on the next trade event"],
  ["pc.state.snapshot()", "engine snapshot summary (counts, cursor, balances — no bulk arrays)"],
  ["pc.state.candles({from?, to?, last?, pre?})", "session candles (default last 50; pre:true prepends history)"],
  ["pc.state.candleAt(time)", "one candle by time (session or pre-history)"],
  ["pc.state.trades()", "active algo's trades (pivot sim trades, or dca fills)"],
  ["pc.state.pivots() / pc.state.sim()", "detected pivots / full pivot sim result"],
  ["pc.state.config() / pc.state.pivotOptions()", "UI config incl. market/interval/range/presets / pivot options"],
  ["pc.chart.visibleRange()", "visible time range as drawn"],
  ["pc.chart.markers()", "trade markers actually rendered (clipped to the cursor)"],
  ["pc.chart.pivotShapes()", "pivot triangles actually rendered"],
  ["pc.chart.priceLines()", "entry/SL/TP price lines currently drawn"],
  ["pc.chart.rangeHighlight() / pc.chart.renderedCandles()", "range selection overlay / candle count + first/last drawn"],
  ["pc.backend.sessions() / pc.backend.session(id)", "read-only positions-backend passthrough"],
  ["pc.verify(sessionId?)", "diff frontend vs backend for a session, or pivot-sim invariants; {ok, mismatches}"],
  ["pc.events.since(seq?) / pc.events.clear()", "structured event log (status/trade/pivots/error/call)"],
  ["pc.help()", "this table"],
]

function help() {
  // eslint-disable-next-line no-console
  console.log(COMMANDS.map(([c, d]) => `${c}\n    ${d}`).join("\n"))
  return COMMANDS.map(([command, doc]) => ({ command, doc }))
}

// ---------------------------------------------------------------- assembly

function buildPc() {
  const api = {
    ready,
    version: 1,
    help: cmd("help", help),
    dump: cmd("dump", dump),

    session: {
      start: cmd("session.start", sessionStart),
      stop: cmd("session.stop", sessionStop),
      loadPreset: cmd("session.loadPreset", async (name: string) => {
        requireApp().loadPreset(name)
        return { loaded: name, ...summary() }
      }),
      loadSession: cmd("session.loadSession", async (id: string, opts: WaitOpts = {}) => {
        requireApp().loadSession(id)
        return waitSnapshot(
          s => {
            if (s.error && s.status === "idle") throw err("engine-error", s.error)
            return s.status === "finished" ? summary(s) : undefined
          },
          `session ${id} to load`,
          opts.timeoutMs ?? 60_000,
        )
      }),
    },

    play: cmd("play", play),
    pause: cmd("pause", pause),
    stepForward: cmd("stepForward", stepForward),
    stepBack: cmd("stepBack", stepBack),
    restart: cmd("restart", restart),
    setSpeed: cmd("setSpeed", setSpeed),
    setAutoResume: cmd("setAutoResume", setAutoResume),
    playTo: cmd("playTo", playTo),

    waitFor: {
      status: cmd("waitFor.status", (status: EngineSnapshot["status"], opts: WaitOpts = {}) =>
        waitSnapshot(s => (s.status === status ? summary(s) : undefined), `status "${status}"`, opts.timeoutMs),
      ),
      time: cmd("waitFor.time", (t: number, opts: WaitOpts = {}) => {
        const target = normTime(t)
        return waitSnapshot(
          s => {
            const c = cursorTime(s)
            return c !== null && c >= target ? summary(s) : undefined
          },
          `cursor to reach ${target}`,
          opts.timeoutMs,
        )
      }),
      finished: cmd("waitFor.finished", (opts: WaitOpts = {}) =>
        waitSnapshot(s => (s.status === "finished" ? summary(s) : undefined), 'status "finished"', opts.timeoutMs),
      ),
      trade: cmd("waitFor.trade", (opts: WaitOpts & { fromSeq?: number } = {}) => {
        const from = opts.fromSeq ?? eventSeq
        return waitEvent(e => e.type === "trade" && e.seq > from, "a trade event", opts.timeoutMs)
      }),
    },

    state: {
      snapshot: cmd("state.snapshot", async () => summary()),
      candles: cmd(
        "state.candles",
        async ({ from, to, last, pre }: { from?: number; to?: number; last?: number; pre?: boolean } = {}) => {
          const s = snap()
          let out: Candle[] = pre ? [...s.preCandles, ...s.candles] : s.candles
          if (from !== undefined) out = out.filter(c => c.time >= normTime(from))
          if (to !== undefined) out = out.filter(c => c.time <= normTime(to))
          if (from === undefined && to === undefined) out = out.slice(-(last ?? 50))
          else if (last !== undefined) out = out.slice(-last)
          return out
        },
      ),
      candleAt: cmd("state.candleAt", async (t: number) => {
        const s = snap()
        const time = normTime(t)
        return [...s.preCandles, ...s.candles].find(c => c.time === time) ?? null
      }),
      trades: cmd("state.trades", async (): Promise<unknown[]> => {
        const s = snap()
        return s.pivotSim ? s.pivotSim.trades : s.trades
      }),
      pivots: cmd("state.pivots", async () => snap().pivots),
      sim: cmd("state.sim", async () => snap().pivotSim),
      config: cmd("state.config", async () => {
        const ui = requireApp().getUi()
        return {
          market: ui.market.symbol,
          interval: ui.interval,
          rangeStart: ui.rangeStart ?? null,
          rangeEnd: ui.rangeEnd ?? null,
          config: ui.config,
          presets: ui.presets,
        }
      }),
      pivotOptions: cmd("state.pivotOptions", async () => requireApp().getUi().pivotOptions),
    },

    chart: {
      visibleRange: cmd("chart.visibleRange", () => settled(c => c.visibleRange())),
      markers: cmd("chart.markers", () => settled(c => c.markers())),
      pivotShapes: cmd("chart.pivotShapes", () => settled(c => c.pivotShapes())),
      priceLines: cmd("chart.priceLines", () => settled(c => c.priceLines())),
      rangeHighlight: cmd("chart.rangeHighlight", () => settled(c => c.rangeHighlight())),
      renderedCandles: cmd("chart.renderedCandles", () => settled(c => c.renderedCandles())),
    },

    backend: {
      sessions: cmd("backend.sessions", () => positions.listSessions()),
      session: cmd("backend.session", (id: string) => positions.getSession(id)),
    },

    verify: cmd("verify", verify),

    events: {
      since: (after = 0): BridgeEvent[] => eventLog.filter(e => e.seq > after),
      clear: (): void => {
        eventLog.length = 0
      },
    },
  }
  // `pc` is callable (the classic dump) with the full API hanging off it.
  return Object.assign((t?: number) => dump(t), api)
}

export type Pc = ReturnType<typeof buildPc>

/** Called once from App when the engine exists. Idempotent (HMR-safe). */
export function installBridge(e: BacktestEngine) {
  engine = e
  ;(window as unknown as { pc: Pc }).pc = buildPc()
  maybeReady()
}
