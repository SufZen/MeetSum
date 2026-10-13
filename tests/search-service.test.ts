import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/search/hebrew-normalize", async () => (await import("./helpers/search-doubles")).normalizerDouble)

const embedQuery = vi.hoisted(() => vi.fn())

vi.mock("@/lib/ai/embeddings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/embeddings")>()),
  embedQuery,
}))

import { InvalidCursorError } from "@/lib/search/cursor"
import type { Legs } from "@/lib/search/rrf"
import {
  groupScore,
  searchWorkspace,
  setSearchEngineForTesting,
  type EngineCapabilities,
  type HydratedChunk,
  type LegRequest,
  type SearchEngine,
} from "@/lib/search/service"
import type { SearchContext, SearchParams } from "@/lib/search/types"

const ctx = {
  scope: { kind: "member", workspaceId: "ws_1", userId: "u_1", email: "u@x.com", role: "member" },
  workspaceId: "ws_1",
  principalKey: "u_1",
  meetings: {} as SearchContext["meetings"],
} satisfies SearchContext

function chunk(id: string, meetingId: string, text: string, extra: Partial<HydratedChunk> = {}): HydratedChunk {
  return {
    id,
    workspaceId: "ws_1",
    meetingId,
    kind: "transcript",
    chunkIndex: 0,
    segmentIds: [`${id}_s1`, `${id}_s2`],
    segmentStartMs: [1000, 5000],
    segmentOffsets: [0, 20],
    overlapCount: 0,
    speakerIds: ["spk"],
    startMs: 1000,
    endMs: 9000,
    language: "he",
    text,
    textNorm: text,
    textStem: "",
    tokenEstimate: 50,
    contentHash: `h_${id}`,
    transcriptVersion: 1,
    meeting: { id: meetingId, title: `Title ${meetingId}`, startedAt: `2026-0${meetingId.slice(-1)}-01T10:00:00.000Z`, source: "upload", tags: [], rooms: [] },
    speakerNames: { spk: "דנה" },
    ...extra,
  }
}

const chunks = [
  chunk("c1", "m1", "דנה: דיברנו על התקציב של השנה"),
  chunk("c2", "m1", "דנה: והתקציב אושר"),
  chunk("c3", "m2", "רון: בתקציב יש חריגה"),
  chunk("c4", "m3", "רון: משהו אחר לגמרי"),
]

function fakeEngine(options: { legs?: Legs; caps?: Partial<EngineCapabilities>; pending?: number; failVector?: boolean } = {}) {
  const requests: LegRequest[] = []
  const engine: SearchEngine = {
    kind: "pg",
    capabilities: async () => ({ vector: false, trgm: true, embeddingKey: null, ...options.caps }),
    runLegs: async (_ctx, request) => {
      requests.push(request)

      return {
        legs: options.legs ?? { fts: [{ id: "c1", score: 0.9 }, { id: "c3", score: 0.5 }, { id: "c2", score: 0.4 }] },
        failed: options.failVector ? ["vector"] : [],
      }
    },
    hydrate: async (_ctx, ids) => chunks.filter((item) => ids.includes(item.id)),
    listMeetings: async (_ctx, _filters, page) => ({
      meetings: chunks.map((item) => item.meeting).filter((meeting, index, all) => all.findIndex((m) => m.id === meeting.id) === index).slice(page.offset, page.offset + page.limit),
      total: 3,
    }),
    countPending: async () => options.pending ?? 0,
    segmentTexts: async () => ({}),
    facets: async () => ({ people: [], speakers: [], rooms: [], tags: [], languages: [], meetingTypes: [], sources: [] }),
  }

  return { engine, requests }
}

function params(overrides: Partial<SearchParams> = {}): SearchParams {
  return { q: "תקציב", filters: {}, group: "meeting", limit: 10, hitsPerMeeting: 3, ...overrides }
}

beforeEach(() => embedQuery.mockReset())
afterEach(() => setSearchEngineForTesting(undefined))

describe("searchWorkspace", () => {
  it("fuses legs, groups by meeting and builds snippets with highlights", async () => {
    const { engine, requests } = fakeEngine({ pending: 2 })

    setSearchEngineForTesting(engine)

    const response = await searchWorkspace(ctx, params())

    expect(response.mode).toBe("lexical")
    expect(response.degraded).toEqual(["no_vector"])
    expect(response.indexCoverage).toEqual({ pending: 2 })
    expect(response.groups?.map((group) => group.meeting.id)).toEqual(["m1", "m2"])
    expect(response.groups?.[0].hits.map((hit) => hit.chunkId)).toEqual(["c1", "c2"])
    expect(response.groups?.[0].score).toBeCloseTo(groupScore([1 / 61, 1 / 63]), 10)

    const hit = response.groups![0].hits[1]

    expect(hit.snippet.slice(hit.highlights[0][0], hit.highlights[0][1])).toBe("והתקציב")
    expect(hit.speakerName).toBe("דנה")
    expect(hit.segmentId).toBe("c2_s1")
    expect(hit.startMs).toBe(1000)
    expect(requests[0].tsquery).toContain("'תקציב':*")
    expect(requests[0].trgm).toBe("תקציב")
    expect(requests[0].vector).toBeNull()
  })

  it("groupScore = best + 0.25·second + 0.1·third", () => {
    expect(groupScore([1, 4, 2, 9])).toBeCloseTo(9 + 1 + 0.2, 10)
    expect(groupScore([])).toBe(0)
  })

  it("returns flat chunk hits with a cursor that round-trips", async () => {
    setSearchEngineForTesting(fakeEngine().engine)

    const first = await searchWorkspace(ctx, params({ group: "chunk", limit: 2 }))

    expect(first.hits?.map((hit) => hit.chunkId)).toEqual(["c1", "c3"])
    expect(first.nextCursor).toBeTruthy()

    const second = await searchWorkspace(ctx, params({ group: "chunk", limit: 2, cursor: first.nextCursor! }))

    expect(second.hits?.map((hit) => hit.chunkId)).toEqual(["c2"])
    expect(second.nextCursor).toBeNull()
  })

  it("rejects a cursor of another query (route → 400)", async () => {
    setSearchEngineForTesting(fakeEngine().engine)

    const first = await searchWorkspace(ctx, params({ group: "chunk", limit: 1 }))

    await expect(searchWorkspace(ctx, params({ q: "אחר", group: "chunk", limit: 1, cursor: first.nextCursor! }))).rejects.toBeInstanceOf(
      InvalidCursorError
    )
    await expect(
      searchWorkspace({ ...ctx, principalKey: "u_2" }, params({ group: "chunk", limit: 1, cursor: first.nextCursor! }))
    ).rejects.toBeInstanceOf(InvalidCursorError)
  })

  it("runs the vector leg when capable and reports hybrid", async () => {
    embedQuery.mockResolvedValue([0.1, 0.2])

    const { engine, requests } = fakeEngine({
      caps: { vector: true, embeddingKey: { model: "m", dimensions: 2 } },
      legs: { vector: [{ id: "c4", score: 0.8 }], fts: [{ id: "c1", score: 1 }] },
    })

    setSearchEngineForTesting(engine)

    const response = await searchWorkspace(ctx, params({ group: "chunk" }))

    expect(response.mode).toBe("hybrid")
    expect(response.degraded).toBeUndefined()
    expect(requests[0].vector).toEqual({ key: { model: "m", dimensions: 2 }, values: [0.1, 0.2] })
    expect(embedQuery).toHaveBeenCalledWith("תקציב", { task: "RETRIEVAL_QUERY", workspaceId: "ws_1", principalKey: "u_1" })
    expect(response.hits?.find((hit) => hit.chunkId === "c4")?.legs.vector).toEqual({ rank: 1, similarity: 0.8 })
  })

  it("degrades to lexical when the query embedding fails or has the wrong size", async () => {
    for (const result of [null, [0.1]]) {
      embedQuery.mockResolvedValueOnce(result)

      const { engine, requests } = fakeEngine({ caps: { vector: true, embeddingKey: { model: "m", dimensions: 2 } } })

      setSearchEngineForTesting(engine)

      const response = await searchWorkspace(ctx, params())

      expect(response.mode).toBe("lexical")
      expect(response.degraded).toContain("query_embedding_failed")
      expect(requests[0].vector).toBeNull()
    }
  })

  it("degrades when the vector leg itself fails, and names a missing provider", async () => {
    embedQuery.mockResolvedValue([0.1, 0.2])
    setSearchEngineForTesting(fakeEngine({ caps: { vector: true, embeddingKey: { model: "m", dimensions: 2 } }, failVector: true }).engine)

    expect((await searchWorkspace(ctx, params())).degraded).toContain("query_embedding_failed")

    setSearchEngineForTesting(fakeEngine({ caps: { vector: true, embeddingKey: null, trgm: false } }).engine)

    const response = await searchWorkspace(ctx, params())

    expect(response.degraded).toEqual(["no_trgm", "no_embedding_provider"])
    expect(embedQuery).toHaveBeenCalledTimes(1)
  })

  it("drops candidates that hydration did not return (scope re-applied)", async () => {
    setSearchEngineForTesting(fakeEngine({ legs: { fts: [{ id: "foreign", score: 1 }, { id: "c3", score: 0.5 }] } }).engine)

    const response = await searchWorkspace(ctx, params({ group: "chunk" }))

    expect(response.hits?.map((hit) => hit.chunkId)).toEqual(["c3"])
  })

  it("lists meetings for an empty q with filters, and is empty without either", async () => {
    setSearchEngineForTesting(fakeEngine().engine)

    const listed = await searchWorkspace(ctx, params({ q: "", filters: { roomIds: ["r1"] }, limit: 2 }))

    expect(listed.groups?.map((group) => group.meeting.id)).toEqual(["m1", "m2"])
    expect(listed.groups?.every((group) => group.hits.length === 0)).toBe(true)
    expect(listed.nextCursor).toBeTruthy()

    const empty = await searchWorkspace(ctx, params({ q: "" }))

    expect(empty).toMatchObject({ mode: "empty", groups: [], nextCursor: null })
  })

  it("clamps limits and hits per meeting", async () => {
    setSearchEngineForTesting(fakeEngine().engine)

    const response = await searchWorkspace(ctx, params({ limit: 999, hitsPerMeeting: 1 }))

    expect(response.groups?.[0].hits).toHaveLength(1)
  })
})
