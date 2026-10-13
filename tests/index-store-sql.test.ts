import { describe, expect, it, vi } from "vitest"

import { chunkTranscript } from "@/lib/search/chunker"
import {
  chunkId,
  createIndexStore,
  IndexMeetingMissingError,
  IndexVersionConflictError,
  toVectorLiteral,
  type IndexWrite,
} from "@/lib/search/index-store"

type Call = { text: string; values: unknown[] }

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim()

/** A pg-Pool-like recorder: `connect()` hands out a client that records into the same log. */
function recordingPool(version: number | null = 3) {
  const calls: Call[] = []
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    calls.push({ text: flat(text), values })
    if (text.includes("for update")) return { rows: version === null ? [] : [{ transcript_version: version }] }
    return { rows: [] }
  })
  const release = vi.fn()

  return { calls, release, pool: { query, connect: async () => ({ query, release }) } }
}

const chunks = chunkTranscript({
  segments: [
    { id: "s1", speaker: "דנה", startMs: 0, endMs: 1_000, text: "התקציב של הרבעון", turnIndex: 0, speakerId: "sp1" },
    { id: "s2", speaker: "Avi", startMs: 1_000, endMs: 2_000, text: "We moved to Supabase", turnIndex: 1 },
  ],
  speakers: [],
})

function write(overrides: Partial<IndexWrite> = {}): IndexWrite {
  return {
    workspaceId: "ws_1",
    meetingId: "m1",
    expectedVersion: 3,
    chunks,
    key: { model: "gemini-embedding-001", dimensions: 2 },
    vectorTable: true,
    vectors: [{ contentHash: chunks[0].contentHash, embedding: [0.6, 0.8] }],
    coversAllChunks: true,
    mode: "hybrid",
    meetingType: "budget_review",
    startedAt: new Date("2026-10-13T10:00:00.000Z"),
    ...overrides,
  }
}

describe("index store SQL", () => {
  it("writes everything in one transaction, in order, with a row lock first", async () => {
    const { calls, pool, release } = recordingPool()

    await createIndexStore(pool).writeIndex(write())

    const statements = calls.map((call) => call.text.split(" ").slice(0, 3).join(" "))

    expect(statements).toEqual([
      "begin",
      "select transcript_version from",
      "delete from meeting_chunks",
      "insert into meeting_chunks",
      "insert into meeting_chunk_embeddings",
      "delete from meeting_chunk_embeddings",
      "delete from meeting_chunk_embeddings",
      "update meetings set",
      "commit",
    ])
    expect(calls[1].text).toBe("select transcript_version from meetings where id = $1 and workspace_id = $2 for update")
    expect(calls[1].values).toEqual(["m1", "ws_1"])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("scopes every statement by workspace_id", async () => {
    const { calls, pool } = recordingPool()

    await createIndexStore(pool).writeIndex(write())
    await createIndexStore(pool).existingHashes("ws_1", "m1", { model: "gemini-embedding-001", dimensions: 2 })
    await createIndexStore(pool).markSkipped("ws_1", "m1")
    await createIndexStore(pool).markFailed("ws_1", "m1", "boom")

    for (const call of calls.filter((entry) => !["begin", "commit"].includes(entry.text))) {
      expect(call.text).toMatch(/workspace_id/)
      expect(call.values).toContain("ws_1")
    }
  })

  it("inserts chunk rows with array casts and the expected values", async () => {
    const { calls, pool } = recordingPool()

    await createIndexStore(pool).writeIndex(write())
    const insert = calls.find((call) => call.text.startsWith("insert into meeting_chunks"))

    expect(insert?.text).toContain("$7::text[], $8::integer[], $9::integer[]")
    expect(insert?.text).toContain("$11::text[]")
    expect(insert?.values.slice(0, 20)).toEqual([
      chunkId("m1", chunks[0]),
      "ws_1",
      "m1",
      "transcript",
      0,
      null,
      ["s1", "s2"],
      [0, 1_000],
      chunks[0].segmentOffsets,
      0,
      ["sp1"],
      0,
      2_000,
      chunks[0].language,
      chunks[0].text,
      chunks[0].textNorm,
      chunks[0].textStem,
      chunks[0].tokenEstimate,
      chunks[0].contentHash,
      3,
    ])
  })

  it("casts vectors with ::vector and uses literal, validated model and dimensions", async () => {
    const { calls, pool } = recordingPool()

    await createIndexStore(pool).writeIndex(write())
    const insert = calls.find((call) => call.text.startsWith("insert into meeting_chunk_embeddings"))
    const cleanup = calls.filter((call) => call.text.startsWith("delete from meeting_chunk_embeddings"))

    expect(insert?.text).toContain("($1, $2, $3, 'gemini-embedding-001', 2, $4::vector)")
    expect(insert?.text).toContain("on conflict do nothing")
    expect(insert?.values).toEqual(["ws_1", "m1", chunks[0].contentHash, "[0.6,0.8]"])
    expect(cleanup[0].text).toContain("model = 'gemini-embedding-001' and dimensions = 2 and not (content_hash = any($3::text[]))")
    expect(cleanup[0].values[2]).toEqual([chunks[0].contentHash])
    expect(cleanup[1].text).toContain("not (model = 'gemini-embedding-001' and dimensions = 2)")
    const update = calls.find((call) => call.text.startsWith("update meetings"))

    expect(update?.values).toEqual(["m1", "ws_1", "hybrid", "gemini-embedding-001:2", "budget_review", "2026-10-13T10:00:00.000Z", 3])
    await expect(
      createIndexStore(pool).writeIndex(write({ key: { model: "x'; drop table meetings; --", dimensions: 2 } }))
    ).rejects.toThrow(/Invalid embedding/)
  })

  it("keeps other keys until the active key covers every chunk, and skips vectors without the table", async () => {
    const partial = recordingPool()

    await createIndexStore(partial.pool).writeIndex(write({ coversAllChunks: false, mode: "lexical", vectors: [] }))
    expect(partial.calls.filter((call) => call.text.startsWith("delete from meeting_chunk_embeddings"))).toHaveLength(1)
    expect(partial.calls.some((call) => call.text.startsWith("insert into meeting_chunk_embeddings"))).toBe(false)
    expect(partial.calls.find((call) => call.text.startsWith("update meetings"))?.values[3]).toBeNull()

    const lexical = recordingPool()

    await createIndexStore(lexical.pool).writeIndex(write({ vectorTable: false, key: null, vectors: [], mode: "lexical" }))
    expect(lexical.calls.some((call) => call.text.includes("meeting_chunk_embeddings"))).toBe(false)
  })

  it("rolls back on a version race (retryable) and when the meeting is gone", async () => {
    const raced = recordingPool(4)

    await expect(createIndexStore(raced.pool).writeIndex(write())).rejects.toBeInstanceOf(IndexVersionConflictError)
    expect(raced.calls.map((call) => call.text).at(-1)).toBe("rollback")
    expect(raced.calls.some((call) => call.text.startsWith("delete from meeting_chunks"))).toBe(false)

    const gone = recordingPool(null)

    await expect(createIndexStore(gone.pool).writeIndex(write())).rejects.toBeInstanceOf(IndexMeetingMissingError)
  })

  it("reads existing hashes for one key with bound parameters", async () => {
    const { calls, pool } = recordingPool()

    await createIndexStore(pool).existingHashes("ws_1", "m1", { model: "gemini-embedding-001", dimensions: 1536 })
    expect(calls[0].text).toBe(
      "select content_hash from meeting_chunk_embeddings where meeting_id = $1 and workspace_id = $2 and model = $3 and dimensions = $4"
    )
    expect(calls[0].values).toEqual(["m1", "ws_1", "gemini-embedding-001", 1536])
  })

  it("marks skipped at the current transcript version and drops stale chunks; failures keep their error", async () => {
    const { calls, pool } = recordingPool()

    await createIndexStore(pool).markSkipped("ws_1", "m1")
    expect(calls.map((call) => call.text.split(" ")[0])).toEqual(["begin", "delete", "update", "commit"])
    expect(calls[2].text).toContain("search_index_state = 'skipped'")
    expect(calls[2].text).toContain("search_indexed_version = transcript_version")

    await createIndexStore(pool).markFailed("ws_1", "m1", "x".repeat(900))
    const failed = calls.at(-1)

    expect(failed?.text).toContain("search_index_state = 'failed'")
    expect(String(failed?.values[2])).toHaveLength(500)
  })

  it("serializes vectors safely", () => {
    expect(toVectorLiteral([1, -0.5, 2e-7])).toBe("[1,-0.5,2e-7]")
    expect(() => toVectorLiteral([Number.NaN])).toThrow()
    expect(() => toVectorLiteral([])).toThrow()
  })
})
