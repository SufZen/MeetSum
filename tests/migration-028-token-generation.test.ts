/**
 * M8 Integration step: migration 028 moves the connection token generation
 * from `config._gen` to `integration_connections.token_generation`.
 * Static checks always run; the PGlite part applies 001–027, writes a
 * 027-era row with `_gen`, applies 028 twice, and is skipped if PGlite
 * cannot load on this host.
 */
import { readFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { listMigrationFiles } from "@/lib/db/migrations"

const SQL = readFileSync("db/migrations/028_integration_token_generation.sql", "utf8").replace(/\r\n/g, "\n")
const flat = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase()

describe("migration 028 (static)", () => {
  it("adds a not-null integer generation column idempotently", () => {
    expect(flat(SQL)).toContain("add column if not exists token_generation integer not null default 0")
  })

  it("strips _gen from config", () => {
    expect(flat(SQL)).toContain("config = config - '_gen'")
  })
})

type PGliteLike = {
  exec(sql: string): Promise<unknown>
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  close(): Promise<void>
}

let db: PGliteLike | undefined
let loadError: unknown

beforeAll(async () => {
  try {
    const { PGlite } = await import("@electric-sql/pglite")
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm")

    db = (await PGlite.create({ extensions: { pg_trgm } })) as unknown as PGliteLike
  } catch (error) {
    loadError = error
    return
  }

  for (const migration of listMigrationFiles("db/migrations").filter((file) => file.version < "028")) {
    await db.exec(migration.sql)
  }
  await db.exec(`
    insert into workspaces (id, name, slug) values ('ws_g', 'G', 'gen-g') on conflict (id) do nothing;
    insert into integration_connections (id, workspace_id, provider, account_label, external_account_id, config)
      values ('intc_a', 'ws_g', 'slack', 'A', 'T1', '{"defaultChannelId":"C1","_gen":7}'::jsonb),
             ('intc_b', 'ws_g', 'notion', 'B', 'N1', '{"_gen":"junk"}'::jsonb),
             ('intc_c', 'ws_g', 'hubspot', 'C', 'H1', '{}'::jsonb);
  `)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe("migration 028 on PGlite", () => {
  it("carries the generation over, strips _gen, and re-runs as a no-op", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    await db.exec(SQL)
    await db.exec(SQL)

    const { rows } = await db.query("select id, token_generation, config from integration_connections order by id")

    expect(rows).toEqual([
      { id: "intc_a", token_generation: 7, config: { defaultChannelId: "C1" } },
      { id: "intc_b", token_generation: 0, config: {} },
      { id: "intc_c", token_generation: 0, config: {} },
    ])
  })
})
