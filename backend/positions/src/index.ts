import Fastify from "fastify"
import cors from "@fastify/cors"
import { initSchema, pool } from "./db.js"

// Fill simulation: taker fee + slippage, both applied only when the session
// has feesEnabled (one UI toggle covers both).
const TAKER_FEE = 0.001
const SLIPPAGE = 0.0005

interface SessionRow {
  id: string
  market: string
  interval: string
  start_time: string
  end_time: string
  mode: string
  algo: string
  algo_config: unknown
  starting_balance: string
  fees_enabled: boolean
  status: string
  quote_balance: string
  base_qty: string
  avg_entry: string | null
  fees_paid: string
  created_at: string
}

function sessionJson(r: SessionRow) {
  return {
    id: r.id,
    createdAt: r.created_at,
    market: r.market,
    interval: r.interval,
    startTime: Number(r.start_time),
    endTime: Number(r.end_time),
    mode: r.mode,
    algo: r.algo,
    algoConfig: r.algo_config,
    startingBalance: Number(r.starting_balance),
    feesEnabled: r.fees_enabled,
    status: r.status,
    quoteBalance: Number(r.quote_balance),
    baseQty: Number(r.base_qty),
    avgEntry: r.avg_entry === null ? null : Number(r.avg_entry),
    feesPaid: Number(r.fees_paid),
  }
}

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

app.get("/api/positions/health", async () => ({ ok: true }))

app.post("/api/positions/sessions", async (req, reply) => {
  const b = req.body as {
    market: string
    interval: string
    startTime: number
    endTime: number
    mode: "replay" | "headless"
    algo: string
    algoConfig: unknown
    startingBalance: number
    feesEnabled: boolean
  }
  if (!b?.market || !b?.interval || !b?.startTime || !b?.endTime || !b?.mode || !b?.algo) {
    return reply.code(400).send({ error: "missing fields" })
  }
  const { rows } = await pool.query<SessionRow>(
    `INSERT INTO sessions
       (market, interval, start_time, end_time, mode, algo, algo_config,
        starting_balance, fees_enabled, quote_balance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8) RETURNING *`,
    [b.market, b.interval, b.startTime, b.endTime, b.mode, b.algo,
     JSON.stringify(b.algoConfig ?? {}), b.startingBalance ?? 1000, b.feesEnabled ?? true],
  )
  return sessionJson(rows[0])
})

app.get("/api/positions/sessions", async () => {
  const { rows } = await pool.query<SessionRow>(
    "SELECT * FROM sessions ORDER BY created_at DESC LIMIT 100",
  )
  return rows.map(sessionJson)
})

app.get("/api/positions/sessions/:id", async (req, reply) => {
  const { id } = req.params as { id: string }
  const { rows } = await pool.query<SessionRow>("SELECT * FROM sessions WHERE id = $1", [id])
  if (rows.length === 0) return reply.code(404).send({ error: "not found" })
  const trades = await pool.query(
    "SELECT time, side, price, base_qty, quote_amount, fee FROM trades WHERE session_id = $1 ORDER BY time",
    [id],
  )
  return {
    ...sessionJson(rows[0]),
    trades: trades.rows.map(t => ({
      time: Number(t.time),
      side: t.side,
      price: Number(t.price),
      baseQty: Number(t.base_qty),
      quoteAmount: Number(t.quote_amount),
      fee: Number(t.fee),
    })),
  }
})

app.get("/api/positions/sessions/:id/state", async (req, reply) => {
  const { id } = req.params as { id: string }
  const { rows } = await pool.query<SessionRow>("SELECT * FROM sessions WHERE id = $1", [id])
  if (rows.length === 0) return reply.code(404).send({ error: "not found" })
  const last = await pool.query(
    "SELECT time FROM trades WHERE session_id = $1 ORDER BY time DESC LIMIT 1",
    [id],
  )
  const count = await pool.query("SELECT count(*)::int AS n FROM trades WHERE session_id = $1", [id])
  return {
    ...sessionJson(rows[0]),
    lastTradeTime: last.rows.length > 0 ? Number(last.rows[0].time) : null,
    tradeCount: count.rows[0].n,
  }
})

app.post("/api/positions/sessions/:id/orders", async (req, reply) => {
  const { id } = req.params as { id: string }
  const b = req.body as { time: number; side: "buy"; quoteAmount: number; price: number }
  if (!b?.time || b?.side !== "buy" || !(b?.quoteAmount > 0) || !(b?.price > 0)) {
    return reply.code(400).send({ error: "invalid order (buy-only MVP)" })
  }
  const { rows } = await pool.query<SessionRow>(
    "SELECT * FROM sessions WHERE id = $1 FOR UPDATE",
    [id],
  )
  if (rows.length === 0) return reply.code(404).send({ error: "not found" })
  const s = rows[0]
  if (s.status !== "active") return reply.code(409).send({ error: "session finished" })

  const quoteBalance = Number(s.quote_balance)
  if (quoteBalance < b.quoteAmount) {
    return reply.code(409).send({ error: "insufficient balance", filled: false })
  }
  const fill = s.fees_enabled ? b.price * (1 + SLIPPAGE) : b.price
  const fee = s.fees_enabled ? b.quoteAmount * TAKER_FEE : 0
  const baseQty = (b.quoteAmount - fee) / fill
  const prevQty = Number(s.base_qty)
  const prevAvg = s.avg_entry === null ? 0 : Number(s.avg_entry)
  const newQty = prevQty + baseQty
  const newAvg = (prevQty * prevAvg + baseQty * fill) / newQty

  await pool.query(
    `UPDATE sessions SET quote_balance = quote_balance - $2, base_qty = $3,
       avg_entry = $4, fees_paid = fees_paid + $5 WHERE id = $1`,
    [id, b.quoteAmount, newQty, newAvg, fee],
  )
  await pool.query(
    `INSERT INTO trades (session_id, time, side, price, base_qty, quote_amount, fee)
     VALUES ($1,$2,'buy',$3,$4,$5,$6)`,
    [id, b.time, fill, baseQty, b.quoteAmount, fee],
  )
  const updated = await pool.query<SessionRow>("SELECT * FROM sessions WHERE id = $1", [id])
  return {
    filled: true,
    trade: { time: b.time, side: "buy", price: fill, baseQty, quoteAmount: b.quoteAmount, fee },
    ...sessionJson(updated.rows[0]),
  }
})

app.post("/api/positions/sessions/:id/finish", async (req, reply) => {
  const { id } = req.params as { id: string }
  const res = await pool.query("UPDATE sessions SET status = 'finished' WHERE id = $1", [id])
  if (res.rowCount === 0) return reply.code(404).send({ error: "not found" })
  return { ok: true }
})

app.delete("/api/positions/sessions/:id", async (req, reply) => {
  const { id } = req.params as { id: string }
  const res = await pool.query("DELETE FROM sessions WHERE id = $1", [id])
  if (res.rowCount === 0) return reply.code(404).send({ error: "not found" })
  return { ok: true }
})

await initSchema()
await app.listen({ host: "0.0.0.0", port: 8101 })
