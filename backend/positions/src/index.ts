import Fastify from "fastify"
import cors from "@fastify/cors"
import { initSchema, pool } from "./db.js"

// Futures-session store. The bot-backend computes the engine snapshot (the
// deterministic backtest result); this service just persists config + snapshot
// so sessions survive reload and list in the overview. No matching, no spot.

interface SessionRow {
  id: string
  created_at: string
  market: string
  interval: string
  start_time: string
  end_time: string
  mode: string
  algo: string
  params: unknown
  starting_balance: string
  fees_enabled: boolean
  leverage: number
  status: string
  snapshot: unknown
}

// List/summary shape — omits the (potentially large) snapshot.
function sessionMeta(r: SessionRow) {
  return {
    id: r.id,
    createdAt: r.created_at,
    market: r.market,
    interval: r.interval,
    startTime: Number(r.start_time),
    endTime: Number(r.end_time),
    mode: r.mode,
    algo: r.algo,
    params: r.params,
    startingBalance: Number(r.starting_balance),
    feesEnabled: r.fees_enabled,
    leverage: r.leverage,
    status: r.status,
  }
}

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

app.get("/api/positions/health", async () => ({ ok: true }))

// Create a session from a completed run: stores config + the engine snapshot.
app.post("/api/positions/sessions", async (req, reply) => {
  const b = req.body as {
    market: string
    interval: string
    startTime: number
    endTime: number
    mode: "replay" | "headless"
    algo: string
    params: unknown
    startingBalance: number
    feesEnabled: boolean
    leverage: number
    snapshot: unknown
  }
  if (!b?.market || !b?.interval || !b?.startTime || !b?.endTime || !b?.mode || !b?.algo || b?.snapshot === undefined) {
    return reply.code(400).send({ error: "missing fields" })
  }
  const { rows } = await pool.query<SessionRow>(
    `INSERT INTO futures_sessions
       (market, interval, start_time, end_time, mode, algo, params,
        starting_balance, fees_enabled, leverage, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [b.market, b.interval, b.startTime, b.endTime, b.mode, b.algo,
     JSON.stringify(b.params ?? {}), b.startingBalance ?? 1000, b.feesEnabled ?? true,
     b.leverage ?? 1, JSON.stringify(b.snapshot)],
  )
  return sessionMeta(rows[0])
})

app.get("/api/positions/sessions", async () => {
  const { rows } = await pool.query<SessionRow>(
    "SELECT * FROM futures_sessions ORDER BY created_at DESC LIMIT 100",
  )
  return rows.map(sessionMeta)
})

app.get("/api/positions/sessions/:id", async (req, reply) => {
  const { id } = req.params as { id: string }
  const { rows } = await pool.query<SessionRow>("SELECT * FROM futures_sessions WHERE id = $1", [id])
  if (rows.length === 0) return reply.code(404).send({ error: "not found" })
  return { ...sessionMeta(rows[0]), snapshot: rows[0].snapshot }
})

app.post("/api/positions/sessions/:id/finish", async (req, reply) => {
  const { id } = req.params as { id: string }
  const res = await pool.query("UPDATE futures_sessions SET status = 'finished' WHERE id = $1", [id])
  if (res.rowCount === 0) return reply.code(404).send({ error: "not found" })
  return { ok: true }
})

app.delete("/api/positions/sessions", async req => {
  const { except } = req.query as { except?: string }
  const res = except
    ? await pool.query("DELETE FROM futures_sessions WHERE id <> $1", [except])
    : await pool.query("DELETE FROM futures_sessions")
  return { ok: true, deleted: res.rowCount ?? 0 }
})

app.delete("/api/positions/sessions/:id", async (req, reply) => {
  const { id } = req.params as { id: string }
  const res = await pool.query("DELETE FROM futures_sessions WHERE id = $1", [id])
  if (res.rowCount === 0) return reply.code(404).send({ error: "not found" })
  return { ok: true }
})

await initSchema()
await app.listen({ host: "0.0.0.0", port: 8101 })
