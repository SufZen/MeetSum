/**
 * M10 A: the core-flow seed (scripts/m10-e2e-seed.ts) on PGlite with every
 * migration applied: guards, rows, Hebrew workspace settings, idempotency.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { assertLocalSeedTarget, M10_W1_SETTINGS, seedM10E2E } from "@/scripts/m10-e2e-seed"

import { createM9Database, type PgLike } from "./helpers/pglite-m9"

const SECRET = "test-secret-0123456789abcdef0123456789"
let db: PgLike | undefined
let env: Record<string, string> = {}

describe("seed guards", () => {
  it("refuses non-local databases and base URLs", () => {
    const of = (extra: Record<string, string>) => extra as unknown as NodeJS.ProcessEnv

    expect(() => assertLocalSeedTarget(of({}))).toThrow(/DATABASE_URL/)
    expect(() => assertLocalSeedTarget(of({ DATABASE_URL: "postgres://u:p@db.example.com/x" }))).toThrow(/localhost/)
    expect(() => assertLocalSeedTarget(of({ DATABASE_URL: "postgres://u:p@127.0.0.1/x", E2E_BASE_URL: "https://meetsum.example.com" }))).toThrow(/localhost/)
    expect(() => assertLocalSeedTarget(of({ DATABASE_URL: "postgres://u:p@127.0.0.1/x", E2E_BASE_URL: "http://localhost:3000" }))).not.toThrow()
  })
})

beforeAll(async () => {
  db = await createM9Database()
  if (!db) return

  const lines = await seedM10E2E(db, { secret: SECRET, now: Date.parse("2026-10-14T12:00:00Z") })

  env = Object.fromEntries(lines.filter((line) => line.includes("=") && !line.startsWith("#")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe("seedM10E2E", () => {
  it("writes three distinct sessions and the workspace ids", (context) => {
    if (!db) return context.skip("PGlite did not load")

    const sessions = [env.E2E_M10_OWNER_SESSION, env.E2E_M10_MEMBER_SESSION, env.E2E_M10_W2_SESSION]

    expect(sessions.every(Boolean)).toBe(true)
    expect(new Set(sessions).size).toBe(3)
    expect(env.E2E_M10_W1_WORKSPACE_ID).not.toBe(env.E2E_M10_W2_WORKSPACE_ID)
  })

  it("creates the memberships and no meetings", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const members = await db.query<{ workspace_id: string; user_id: string; role: string }>(
      "select workspace_id, user_id, role from memberships where workspace_id like 'e2e\\_m10\\_%' order by user_id"
    )
    const meetings = await db.query<{ count: number }>("select count(*)::int as count from meetings where workspace_id like 'e2e\\_m10\\_%'")

    expect(members.rows.map((row) => row.role).sort()).toEqual(["member", "owner", "owner"])
    expect(meetings.rows[0]!.count).toBe(0)
  })

  it("gives W1 the Hebrew defaults the replay recordings are written for", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    const rows = await db.query<{ key: string; value: unknown }>("select key, value from workspace_settings where workspace_id = $1", [env.E2E_M10_W1_WORKSPACE_ID])
    const settings = Object.fromEntries(rows.rows.map((row) => [row.key, row.value]))

    expect(settings).toMatchObject(M10_W1_SETTINGS)
    expect(settings.summaryTemplate).toBe("hebrew_business")
  })

  it("is idempotent", async (context) => {
    if (!db) return context.skip("PGlite did not load")

    await expect(seedM10E2E(db, { secret: SECRET })).resolves.toBeTruthy()
  })
})
