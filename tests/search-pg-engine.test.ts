import { describe, expect, it } from "vitest"

import { createPgSearchEngine, mapHydratedRow } from "@/lib/search/pg-engine"
import { searchConfig, type LegRequest } from "@/lib/search/service"
import type { SearchCapabilities, SearchContext } from "@/lib/search/types"

type Call = { text: string; values?: unknown[]; inTx: boolean }

function recordingPool(responder: (text: string) => unknown[] = () => [], failOn?: RegExp) {
  const calls: Call[] = []
  let inTx = false
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values, inTx })
    if (text === "begin") inTx = true
    if (text === "commit" || text === "rollback") inTx = false
    if (failOn?.test(text)) throw new Error("boom")

    return { rows: responder(text) }
  }

  return {
    calls,
    pool: { query, connect: async () => ({ query, release: () => undefined }) },
  }
}

function caps(overrides: Partial<SearchCapabilities> = {}): SearchCapabilities {
  return {
    vector: { available: true, tableReady: true, indexReady: true },
    trgm: { installed: true, hebrew: true },
    embeddingKey: { model: "gemini-embedding-001", dimensions: 2 },
    checkedAt: "now",
    ...overrides,
  }
}

const ctx = {
  scope: { kind: "api_key", workspaceId: "ws_1" },
  workspaceId: "ws_1",
  principalKey: "key:k",
  meetings: {} as SearchContext["meetings"],
} satisfies SearchContext

function request(overrides: Partial<LegRequest> = {}): LegRequest {
  return {
    nq: { input: "x", folded: "תקציב", tokens: [] },
    tsquery: "('תקציב':*)",
    trgm: "תקציב",
    filters: {},
    vector: { key: { model: "gemini-embedding-001", dimensions: 2 }, values: [0.6, 0.8] },
    config: searchConfig({}),
    ...overrides,
  }
}

describe("pg engine legs", () => {
  it("runs vector, FTS and trigram legs in one transaction with set local inside it", async () => {
    const { calls, pool } = recordingPool((text) =>
      text.includes("<=>") ? [{ id: "c2", score: 0.4 }, { id: "c1", score: 0.9 }] : text.includes("ts_rank_cd") ? [{ id: "c1", score: 0.3 }] : []
    )
    const engine = createPgSearchEngine({ client: pool, capabilities: async () => caps() })
    const { legs, failed } = await engine.runLegs(ctx, request())
    const texts = calls.map((call) => call.text.split("\n")[0])

    expect(texts[0]).toBe("begin")
    expect(texts).toContain("set local hnsw.ef_search = 100")
    expect(texts).toContain("set local hnsw.iterative_scan = relaxed_order")
    expect(texts).toContain("set local pg_trgm.word_similarity_threshold = 0.45")
    expect(texts[texts.length - 1]).toBe("commit")
    expect(calls.filter((call) => call.text.startsWith("set local")).every((call) => call.inTx)).toBe(true)
    expect(calls.filter((call) => call.text.startsWith("select")).every((call) => call.inTx)).toBe(true)
    expect(legs.vector?.map((row) => row.id)).toEqual(["c1", "c2"])
    expect(legs.fts?.map((row) => row.id)).toEqual(["c1"])
    expect(failed).toEqual([])
  })

  it("omits the vector leg without a query vector and the trigram leg without a trigram query", async () => {
    const { calls, pool } = recordingPool()
    const engine = createPgSearchEngine({ client: pool, capabilities: async () => caps() })

    await engine.runLegs(ctx, request({ vector: null, trgm: null }))

    expect(calls.some((call) => call.text.includes("<=>") || call.text.includes("hnsw"))).toBe(false)
    expect(calls.some((call) => call.text.includes("word_similarity"))).toBe(false)
    expect(calls.some((call) => call.text.includes("ts_rank_cd"))).toBe(true)
  })

  it("degrades a failing vector leg via a savepoint instead of failing the search", async () => {
    const { calls, pool } = recordingPool(() => [], /<=>/)
    const engine = createPgSearchEngine({ client: pool, capabilities: async () => caps() })
    const { failed, legs } = await engine.runLegs(ctx, request())

    expect(failed).toEqual(["vector"])
    expect(legs.vector).toBeUndefined()
    expect(calls.map((call) => call.text)).toContain("rollback to savepoint search_vector_leg")
    expect(calls.some((call) => call.text.includes("ts_rank_cd"))).toBe(true)
  })

  it("maps capabilities: vector needs the index, trigram needs Hebrew trigrams", async () => {
    const engine = (value: SearchCapabilities) => createPgSearchEngine({ client: recordingPool().pool, capabilities: async () => value })

    expect(await engine(caps()).capabilities(ctx)).toEqual({ vector: true, trgm: true, embeddingKey: { model: "gemini-embedding-001", dimensions: 2 } })
    expect((await engine(caps({ vector: { available: true, tableReady: true, indexReady: false } })).capabilities(ctx)).vector).toBe(false)
    expect((await engine(caps({ trgm: { installed: true, hebrew: false } })).capabilities(ctx)).trgm).toBe(false)
  })
})

describe("pg engine reads", () => {
  it("hydrates rows (arrays, json, dates) and skips the query for no ids", async () => {
    const row = {
      id: "c1",
      workspace_id: "ws_1",
      meeting_id: "m1",
      kind: "transcript",
      chunk_index: 0,
      source_id: null,
      segment_ids: ["s1", "s2"],
      segment_start_ms: [0, 1000],
      segment_offsets: [0, 12],
      overlap_count: 1,
      speaker_ids: ["spk"],
      start_ms: 1000,
      end_ms: 2000,
      language: "he",
      text: "דנה: שלום",
      text_norm: "דנה שלומ",
      text_stem: "",
      token_estimate: 5,
      content_hash: "h",
      transcript_version: 3,
      title: "T",
      started_at: new Date("2026-09-01T09:00:00.000Z"),
      source: "upload",
      meeting_language: "he",
      meeting_type: "board",
      duration_ms: 60000,
      rooms: [{ id: "r", name: "R" }],
      tags: '["a"]',
      speaker_names: { spk: "דנה" },
    }
    const { calls, pool } = recordingPool(() => [row])
    const engine = createPgSearchEngine({ client: pool, capabilities: async () => caps() })

    expect(await engine.hydrate(ctx, [])).toEqual([])
    expect(calls).toHaveLength(0)

    const [chunk] = await engine.hydrate(ctx, ["c1"])

    expect(chunk).toEqual(mapHydratedRow(row))
    expect(chunk.meeting).toEqual({
      id: "m1",
      title: "T",
      startedAt: "2026-09-01T09:00:00.000Z",
      source: "upload",
      language: "he",
      meetingType: "board",
      durationMs: 60000,
      tags: ["a"],
      rooms: [{ id: "r", name: "R" }],
    })
    expect(chunk.overlapCount).toBe(1)
    expect(calls[0].values?.[0]).toBe("ws_1")
  })

  it("facets, pending count, meeting list and segment texts run scoped statements", async () => {
    const { calls, pool } = recordingPool((text) => {
      if (text.includes("count(*)::int as pending")) return [{ pending: 4 }]
      if (text.includes("array_agg(distinct m.language)")) return [{ languages: ["he", "auto"], meeting_types: ["board"], sources: ["upload"] }]
      if (text.includes("from transcript_segments")) return [{ id: "s1", text: "שלום" }]
      if (text.includes("count(*) over ()")) return [{ id: "m1", title: "T", started_at: "2026-01-01", source: "upload", total: 7 }]

      return []
    })
    const engine = createPgSearchEngine({ client: pool, capabilities: async () => caps() })

    expect(await engine.countPending(ctx, {})).toBe(4)
    expect((await engine.facets(ctx)).languages).toEqual(["he"])
    expect(await engine.segmentTexts(ctx, ["s1"])).toEqual({ s1: "שלום" })
    expect((await engine.listMeetings(ctx, { tags: ["x"] }, { limit: 5, offset: 0 })).total).toBe(7)
    expect(calls.every((call) => call.values?.[0] === "ws_1")).toBe(true)
    expect(calls.every((call) => call.text.includes("m.visibility in ('workspace', 'link')"))).toBe(true)
  })
})
