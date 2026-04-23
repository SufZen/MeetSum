import pg from "pg"

const { Pool } = pg

export type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
}

let pool: pg.Pool | undefined

export function getDatabasePool(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required")
  }

  pool ??= new Pool({ connectionString: databaseUrl })

  return pool
}
