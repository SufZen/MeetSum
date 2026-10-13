import { readFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { buildReserveAskUsageSql, createMemoryAskUsageCounter, createPgAskUsageCounter } from "@/lib/ask/usage"

/**
 * Durable AskMeetSum daily cap (M6 review): an atomic per-principal counter
 * (`ask_usage`, migration 026) reserved before the LLM call, so API keys,
 * `persist:false` asks and parallel requests are all counted, across
 * processes and restarts.
 */

const SQL = readFileSync("db/migrations/026_ask_usage.sql", "utf8")
const flat = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase()

describe("migration 026 (static)", () => {
  it("creates ask_usage keyed by workspace, principal and day", () => {
    const sql = flat(SQL)

    expect(sql).toContain("create table if not exists ask_usage")
    expect(sql).toContain("workspace_id text not null references workspaces(id) on delete cascade")
    expect(sql).toContain("principal_key text not null")
    expect(sql).toContain("day date not null")
    expect(sql).toContain("count integer not null default 0")
    expect(sql).toContain("primary key (workspace_id, principal_key, day)")
  })

  it("is mirrored in db/schema.sql", () => {
    const schema = flat(readFileSync("db/schema.sql", "utf8"))

    expect(schema).toContain("create table if not exists ask_usage")
    expect(schema).toContain("primary key (workspace_id, principal_key, day)")
  })
})

describe("reserve SQL", () => {
  it("is one atomic upsert that only increments below the limit", () => {
    const sql = buildReserveAskUsageSql({ workspaceId: "ws_a", principalKey: "user:u1", day: "2026-10-13", limit: 5 })
    const text = flat(sql.text)

    expect(text).toContain("insert into ask_usage (workspace_id, principal_key, day, count)")
    expect(text).toContain("on conflict (workspace_id, principal_key, day) do update set count = ask_usage.count + 1")
    expect(text).toContain("where ask_usage.count < $4")
    expect(text).toContain("returning count")
    expect(sql.values).toEqual(["ws_a", "user:u1", "2026-10-13", 5])
  })
})

describe("memory counter", () => {
  it("never grants more than the limit, even for parallel reservations", async () => {
    const counter = createMemoryAskUsageCounter()
    const input = { workspaceId: "ws_a", principalKey: "user:u1", day: "2026-10-13", limit: 3 }
    const results = await Promise.all(Array.from({ length: 10 }, () => counter.reserve(input)))

    expect(results.filter((count) => count !== null)).toEqual([1, 2, 3])
    expect(await counter.reserve({ ...input, principalKey: "user:u2" })).toBe(1)
    expect(await counter.reserve({ ...input, day: "2026-10-14" })).toBe(1)
    expect(await counter.reserve({ ...input, workspaceId: "ws_b" })).toBe(1)
  })
})

type PGliteLike = {
  exec(sql: string): Promise<unknown>
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  close(): Promise<void>
}

let db: PGliteLike | undefined
let loadError: unknown

beforeAll(async () => {
  try {
    const { PGlite } = await import("@electric-sql/pglite")

    db = (await PGlite.create()) as unknown as PGliteLike
    await db.exec("create table workspaces (id text primary key); insert into workspaces (id) values ('ws_a'), ('ws_b');")
  } catch (error) {
    loadError = error
  }
}, 60_000)

afterAll(async () => {
  await db?.close()
})

describe("pg counter on PGlite", () => {
  it("applies 026 idempotently and enforces the cap atomically for parallel reservations", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    await db.exec(SQL)
    await db.exec(SQL)

    const pglite = db
    const counter = createPgAskUsageCounter({ query: (text, values) => pglite.query(text, values) })
    const input = { workspaceId: "ws_a", principalKey: "api_key:k1", day: "2026-10-13", limit: 4 }
    const results = await Promise.all(Array.from({ length: 9 }, () => counter.reserve(input)))

    expect(results.filter((count) => count !== null).sort()).toEqual([1, 2, 3, 4])

    const row = await db.query("select count from ask_usage where workspace_id = 'ws_a' and principal_key = 'api_key:k1'")

    expect(row.rows[0]).toEqual({ count: 4 })
    expect(await counter.reserve({ ...input, workspaceId: "ws_b" })).toBe(1)
  })
})
