import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/search/hebrew-normalize", async () => (await import("./helpers/search-doubles")).normalizerDouble)

import { retrievalQuery, retrievePassages } from "@/lib/search/retrieve"
import type { HydratedChunk, LegRequest, SearchEngine } from "@/lib/search/service"
import type { SearchContext } from "@/lib/search/types"

const ctx = {
  scope: { kind: "member", workspaceId: "ws_1", userId: "u_1", email: "u@x.com", role: "member" },
  workspaceId: "ws_1",
  principalKey: "u_1",
  meetings: {} as SearchContext["meetings"],
} satisfies SearchContext

function chunk(id: string, meetingId: string, segments: string[], extra: Partial<HydratedChunk> = {}): HydratedChunk {
  return {
    id,
    workspaceId: "ws_1",
    meetingId,
    kind: "transcript",
    chunkIndex: 0,
    segmentIds: segments,
    segmentStartMs: segments.map((_, index) => index * 1000),
    segmentOffsets: segments.map((_, index) => index * 10),
    overlapCount: 0,
    speakerIds: ["spk"],
    text: "תקציב",
    textNorm: "תקציב",
    textStem: "",
    tokenEstimate: 100,
    contentHash: `h_${id}`,
    transcriptVersion: 1,
    meeting: { id: meetingId, title: `T ${meetingId}`, startedAt: "2026-09-01T00:00:00.000Z", source: "upload", tags: [], rooms: [] },
    speakerNames: { spk: "דנה" },
    ...extra,
  }
}

function engine(chunks: HydratedChunk[], options: { vector?: boolean } = {}) {
  const requests: LegRequest[] = []
  const fake: SearchEngine = {
    kind: "pg",
    capabilities: async () => ({ vector: Boolean(options.vector), trgm: true, embeddingKey: options.vector ? { model: "m", dimensions: 1 } : null }),
    queryVector: async () => [1],
    runLegs: async (_ctx, request) => {
      requests.push(request)

      return {
        legs: {
          fts: chunks.filter((item) => !item.id.startsWith("v")).map((item, index) => ({ id: item.id, score: 1 - index / 100 })),
          ...(request.vector ? { vector: chunks.map((item, index) => ({ id: item.id, score: 0.9 - index / 100 })) } : {}),
        },
      }
    },
    hydrate: async (_ctx, ids) => chunks.filter((item) => ids.includes(item.id)),
    listMeetings: async () => ({ meetings: [], total: 0 }),
    countPending: async () => undefined,
    segmentTexts: async (_ctx, ids) => Object.fromEntries(ids.map((id) => [id, `text of ${id}`])),
    facets: async () => ({ people: [], speakers: [], rooms: [], tags: [], languages: [], meetingTypes: [], sources: [] }),
  }

  return { fake, requests }
}

describe("retrievePassages", () => {
  it("caps passages per meeting at 4 in workspace and room scope, not in meeting scope", async () => {
    const chunks = Array.from({ length: 6 }, (_, index) => chunk(`c${index}`, "m1", [`s${index}`])).concat(chunk("x1", "m2", ["t1"]))
    const { fake } = engine(chunks)

    const workspace = await retrievePassages(ctx, { question: "תקציב", scope: { kind: "workspace" } }, { engine: fake, env: {} })

    expect(workspace.passages.filter((passage) => passage.chunk.meetingId === "m1")).toHaveLength(4)
    expect(workspace.passages.map((passage) => passage.chunk.id)).toContain("x1")

    const room = await retrievePassages(ctx, { question: "תקציב", scope: { kind: "room", roomId: "r1" } }, { engine: fake, env: {} })

    expect(room.passages.filter((passage) => passage.chunk.meetingId === "m1")).toHaveLength(4)

    const meeting = await retrievePassages(ctx, { question: "תקציב", scope: { kind: "meeting", meetingId: "m1" } }, { engine: fake, env: {} })

    expect(meeting.passages.filter((passage) => passage.chunk.meetingId === "m1")).toHaveLength(6)
  })

  it("maps the ask scope to filters", async () => {
    const { fake, requests } = engine([chunk("c1", "m1", ["s1"])])

    await retrievePassages(ctx, { question: "q1", scope: { kind: "meeting", meetingId: "m1" } }, { engine: fake, env: {} })
    await retrievePassages(ctx, { question: "q1", scope: { kind: "room", roomId: "r9" } }, { engine: fake, env: {} })
    await retrievePassages(ctx, { question: "q1", scope: { kind: "workspace" } }, { engine: fake, env: {} })

    expect(requests.map((request) => request.filters)).toEqual([{ meetingIds: ["m1"] }, { roomIds: ["r9"] }, {}])
  })

  it("greedily fills the token budget and the passage limit", async () => {
    const chunks = [
      chunk("big", "m1", ["s1"], { tokenEstimate: 900 }),
      chunk("small1", "m2", ["s2"], { tokenEstimate: 300 }),
      chunk("small2", "m3", ["s3"], { tokenEstimate: 300 }),
      chunk("small3", "m4", ["s4"], { tokenEstimate: 300 }),
    ]
    const { fake } = engine(chunks)
    const result = await retrievePassages(ctx, { question: "תקציב", scope: { kind: "workspace" }, budgetTokens: 1000 }, { engine: fake, env: {} })

    expect(result.passages.map((passage) => passage.chunk.id)).toEqual(["big"])

    const limited = await retrievePassages(ctx, { question: "תקציב", scope: { kind: "workspace" }, budgetTokens: 1000, limit: 2 }, { engine: fake, env: {} })

    expect(limited.passages).toHaveLength(1)

    const roomy = await retrievePassages(ctx, { question: "תקציב", scope: { kind: "workspace" } }, { engine: fake, env: { MEETSUM_ASK_CONTEXT_TOKENS: "700", MEETSUM_ASK_MAX_PASSAGES: "2" } })

    expect(roomy.passages.map((passage) => passage.chunk.id)).toEqual(["small1", "small2"])
  })

  it("drops overlap duplicates and returns own-segment texts only", async () => {
    const chunks = [
      chunk("a", "m1", ["s1", "s2", "s3"]),
      chunk("b", "m1", ["s2", "s3"], { overlapCount: 1 }),
      chunk("c", "m1", ["s3", "s4"], { overlapCount: 1 }),
    ]
    const { fake } = engine(chunks)
    const result = await retrievePassages(ctx, { question: "תקציב", scope: { kind: "meeting", meetingId: "m1" } }, { engine: fake, env: {} })

    expect(result.passages.map((passage) => passage.chunk.id)).toEqual(["a", "c"])
    expect(result.passages[1].segmentTexts).toEqual({ s4: "text of s4" })
    expect(result.passages[0]).toMatchObject({ meetingTitle: "T m1", speakerNames: { spk: "דנה" } })
    expect(result.passages[0].chunk).not.toHaveProperty("meeting")
  })

  it("reports topSimilarity and lexicalHits for the refusal gate", async () => {
    const lexical = await retrievePassages(ctx, { question: "תקציב", scope: { kind: "workspace" } }, { engine: engine([chunk("c1", "m1", ["s1"])]).fake, env: {} })

    expect(lexical).toMatchObject({ mode: "lexical", topSimilarity: null, lexicalHits: 1 })

    const hybrid = await retrievePassages(
      ctx,
      { question: "תקציב", scope: { kind: "workspace" } },
      { engine: engine([chunk("c1", "m1", ["s1"]), chunk("v1", "m2", ["s9"])], { vector: true }).fake, env: {} }
    )

    expect(hybrid.mode).toBe("hybrid")
    expect(hybrid.topSimilarity).toBeCloseTo(0.9, 6)
    expect(hybrid.lexicalHits).toBe(1)
  })

  it("passes the caller signal to the query embedding", async () => {
    const { fake } = engine([chunk("c1", "m1", ["s1"])], { vector: true })
    const queryVector = vi.fn(async () => [1])
    const controller = new AbortController()

    await retrievePassages(
      ctx,
      { question: "תקציב", scope: { kind: "workspace" } },
      { engine: { ...fake, queryVector }, env: {}, signal: controller.signal }
    )

    expect(queryVector).toHaveBeenCalledWith(ctx, "תקציב", "QUESTION_ANSWERING", controller.signal)
  })

  it("adds the previous question for follow-ups and is empty for a blank question", async () => {
    expect(retrievalQuery({ question: " ומה עם התקציב? ", previousQuestion: "מה הוחלט על הגיוס" })).toBe("ומה עם התקציב? מה הוחלט על הגיוס")

    const { fake, requests } = engine([])

    expect(await retrievePassages(ctx, { question: "  ", scope: { kind: "workspace" } }, { engine: fake, env: {} })).toEqual({
      passages: [],
      mode: "empty",
      topSimilarity: null,
      lexicalHits: 0,
    })
    expect(requests).toHaveLength(0)
  })
})
