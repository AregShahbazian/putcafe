import pg from "pg"

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://putcafe:putcafe@db:5432/putcafe",
})

export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now(),
      market text NOT NULL,
      interval text NOT NULL,
      start_time bigint NOT NULL,
      end_time bigint NOT NULL,
      mode text NOT NULL,
      algo text NOT NULL,
      algo_config jsonb NOT NULL,
      starting_balance numeric NOT NULL,
      fees_enabled boolean NOT NULL,
      status text NOT NULL DEFAULT 'active',
      quote_balance numeric NOT NULL,
      base_qty numeric NOT NULL DEFAULT 0,
      avg_entry numeric,
      fees_paid numeric NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS trades (
      id bigserial PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      time bigint NOT NULL,
      side text NOT NULL,
      price numeric NOT NULL,
      base_qty numeric NOT NULL,
      quote_amount numeric NOT NULL,
      fee numeric NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trades_session_idx ON trades (session_id, time);
  `)
}
