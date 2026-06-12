import pg from "pg"

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://putcafe:putcafe@db:5432/putcafe",
})

// Futures-only store: a session is its config plus the engine snapshot (the
// deterministic result — positions, orders, trades, events, equity). The
// snapshot is the durable truth; replay reveals it by cursor. The old spot
// `sessions`/`trades` tables are left untouched (dead data, no code path).
export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS futures_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now(),
      market text NOT NULL,
      interval text NOT NULL,
      start_time bigint NOT NULL,
      end_time bigint NOT NULL,
      mode text NOT NULL,
      algo text NOT NULL,
      params jsonb NOT NULL,
      starting_balance numeric NOT NULL,
      fees_enabled boolean NOT NULL,
      leverage integer NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'active',
      snapshot jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS futures_sessions_created_idx
      ON futures_sessions (created_at DESC);
  `)
}
