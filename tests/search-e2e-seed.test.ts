/**
 * The e2e seed path (`seedPgliteMeetings`, used by scripts/search-e2e-seed.ts
 * against a real pg.Pool): `query` must keep its `this`, and a rerun after a
 * partial or complete seed must succeed without duplicating rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/search/hebrew-normalize", async () => (await import("./helpers/search-doubles")).normalizerDouble)
vi.mock("@/lib/search/chunker", async () => (await import("./helpers/search-doubles")).chunkerDouble)
vi.mock("@/lib/search/chunk-sources", async () => (await import("./helpers/search-doubles")).chunkSourcesDouble)

import { createPgliteSearchDb, seedPgliteMeetings, type PgliteSearchDb } from "@/lib/search/eval/pglite"
import { defaultChunkMeeting } from "@/lib/search/memory-engine"

import { searchCorpus } from "./helpers/search-fixtures"

let db: PgliteSearchDb | null = null

beforeAll(async () => {
  db = await createPgliteSearchDb()
}, 120_000)

afterAll(async () => {
  await db?.close()
})

/** Like pg.Pool: `query` is a method that needs its `this`. */
class PoolLike {
  constructor(private readonly inner: PgliteSearchDb["client"]) {}

  query(text: string, values?: unknown[]) {
    return this.inner.query(text, values)
  }
}

describe("seedPgliteMeetings on a pool-like client", () => {
  it("keeps `this` for the client's query and is idempotent on rerun", async () => {
    if (!db) return

    const client = new PoolLike(db.client)
    const meetings = searchCorpus()

    await seedPgliteMeetings({ client }, meetings, defaultChunkMeeting)
    const count = async (table: string) =>
      Number(((await db!.client.query(`select count(*)::int as n from ${table}`)).rows[0] as { n: number }).n)
    const before = {
      participants: await count("meeting_participants"),
      segments: await count("transcript_segments"),
      speakers: await count("speakers"),
      chunks: await count("meeting_chunks"),
    }

    await seedPgliteMeetings({ client }, meetings, defaultChunkMeeting)

    expect({
      participants: await count("meeting_participants"),
      segments: await count("transcript_segments"),
      speakers: await count("speakers"),
      chunks: await count("meeting_chunks"),
    }).toEqual(before)
    expect(before.segments).toBeGreaterThan(0)
  })
})
