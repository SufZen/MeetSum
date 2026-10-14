/**
 * M10 Step 0 (docs/parity/m10.md, "Migration 032_drop_integration_endpoints.sql"):
 * the legacy integration_endpoints table (002) is dropped when empty and
 * renamed to integration_endpoints_legacy when it has rows. Static checks
 * always run; the PGlite part applies 001–031, applies 032 twice on the empty
 * table, then on a populated table, and is skipped if PGlite cannot load.
 */
import { readFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { listMigrationFiles } from "@/lib/db/migrations"

const SQL = readFileSync("db/migrations/032_drop_integration_endpoints.sql", "utf8").replace(/\r\n/g, "\n")
const flat = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase()

describe("migration 032 (static)", () => {
  const sql = flat(SQL)

  it("runs inside one DO block guarded by an information_schema lookup", () => {
    expect(sql.trim().startsWith("do $$ begin")).toBe(true)
    expect(sql.trim().endsWith("end $$;")).toBe(true)
    expect(sql).toContain(
      "if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'integration_endpoints') then"
    )
  })

  it("renames instead of dropping when the table has rows", () => {
    const rowCheck = sql.indexOf("if exists (select 1 from integration_endpoints limit 1) then")
    const rename = sql.indexOf("alter table integration_endpoints rename to integration_endpoints_legacy;")
    const drop = sql.indexOf("drop table integration_endpoints;")

    expect(rowCheck).toBeGreaterThan(-1)
    expect(rename).toBeGreaterThan(rowCheck)
    expect(drop).toBeGreaterThan(rename)
    expect(sql.slice(rename, drop)).toContain("else")
  })

  it("never drops with cascade or touches another table", () => {
    expect(sql).not.toContain("cascade")
    expect(sql.match(/\b(?:drop|alter) table (\w+)/g)).toEqual([
      "alter table integration_endpoints",
      "drop table integration_endpoints",
    ])
  })

  it("is mirrored in db/schema.sql (the table is gone)", () => {
    const schema = flat(readFileSync("db/schema.sql", "utf8"))

    expect(schema).not.toContain("create table if not exists integration_endpoints")
  })
})

type PGliteLike = {
  exec(sql: string): Promise<unknown>
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
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

  for (const migration of listMigrationFiles("db/migrations").filter((file) => file.version < "032")) {
    await db.exec(migration.sql)
  }
}, 120_000)

afterAll(async () => {
  await db?.close()
})

async function tables(): Promise<string[]> {
  const result = await db!.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name like 'integration_endpoints%'
      order by table_name`
  )

  return result.rows.map((row) => row.table_name)
}

describe("migration 032 on PGlite", () => {
  it("drops the empty legacy table and re-runs as a no-op", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    expect(await tables()).toEqual(["integration_endpoints"])
    await db.exec(SQL)
    expect(await tables()).toEqual([])
    await db.exec(SQL)
    expect(await tables()).toEqual([])
  })

  it("renames a populated table to integration_endpoints_legacy and keeps its rows", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    await db.exec(`
      create table integration_endpoints (id text primary key, name text not null);
      insert into integration_endpoints (id, name) values ('ie_1', 'legacy');
    `)
    await db.exec(SQL)
    expect(await tables()).toEqual(["integration_endpoints_legacy"])
    await db.exec(SQL)
    expect(await tables()).toEqual(["integration_endpoints_legacy"])

    const rows = await db.query<{ id: string }>("select id from integration_endpoints_legacy")

    expect(rows.rows).toEqual([{ id: "ie_1" }])
  })
})
