import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/search/hebrew-normalize", async () => (await import("./helpers/search-doubles")).normalizerDouble)
vi.mock("@/lib/search/chunker", async () => (await import("./helpers/search-doubles")).chunkerDouble)
vi.mock("@/lib/search/chunk-sources", async () => (await import("./helpers/search-doubles")).chunkSourcesDouble)

import { toRepoScope } from "@/lib/auth/authz"
import { createInMemoryMeetingDatabase, createInMemoryMeetingRepository } from "@/lib/meetings/repository"
import { normalizeQuery } from "@/lib/search/hebrew-normalize"
import { createMemorySearchEngine, ftsScore, textMatchesQuery, wordSimilarity } from "@/lib/search/memory-engine"
import { rankCandidates, searchConfig, searchWorkspace, setSearchEngineForTesting } from "@/lib/search/service"
import type { SearchContext } from "@/lib/search/types"

import { COLLIDING_TERM, searchCorpus } from "./helpers/search-fixtures"

const database = createInMemoryMeetingDatabase(searchCorpus())

function context(kind: "owner" | "member" | "viewer" | "key" | "key_owner" | "w2"): SearchContext {
  const workspace = { id: kind === "w2" ? "ws_b" : "ws_a", name: "W", slug: "w" }
  const base =
    kind === "key" || kind === "key_owner"
      ? { principal: "api_key" as const, apiKey: { id: "k1", scopes: ["read" as const], createdByUserId: kind === "key_owner" ? "user_owner" : undefined }, workspace, role: "member" as const }
      : {
          principal: "user" as const,
          user: kind === "owner" ? { id: "user_owner", email: "owner@a.com" } : { id: "user_other", email: "other@a.com" },
          workspace,
          role: kind === "viewer" ? ("viewer" as const) : ("member" as const),
        }
  const scope = toRepoScope(base)

  return {
    scope,
    workspaceId: workspace.id,
    principalKey: base.principal === "user" ? base.user!.id : "key:k1",
    meetings: createInMemoryMeetingRepository(database, scope),
  }
}

async function meetingIds(ctx: SearchContext, q: string, filters = {}) {
  const engine = createMemorySearchEngine()
  const ranked = await rankCandidates(ctx, { q, filters, task: "RETRIEVAL_QUERY", engine })

  return [...new Set(ranked.candidates.map((candidate) => candidate.chunk.meetingId))]
}

describe("memory engine scoring", () => {
  it("ftsScore weighs raw (A) above stems (B) and supports :* prefixes", () => {
    const groups = [[{ value: "תקציב", prefix: true }]]

    expect(ftsScore(["תקציב"], [], groups)).toBeGreaterThan(ftsScore(["בתקציב"], ["תקציב"], groups))
    expect(ftsScore(["תקציבים"], [], groups)).toBeGreaterThan(0)
    expect(ftsScore(["אחר"], [], groups)).toBe(0)
  })

  it("wordSimilarity finds near matches and ignores unrelated text", () => {
    expect(wordSimilarity("supabase", ["עברנו", "לsupabase"])).toBeGreaterThan(0.45)
    expect(wordSimilarity("supabase", ["postgres", "firebase"])).toBeLessThan(0.45)
  })

  it("textMatchesQuery keeps short tokens and prefixes", () => {
    expect(textMatchesQuery("דיברנו על AI ועל Q3", normalizeQuery("ai"))).toBe(true)
    expect(textMatchesQuery("בתקציב", normalizeQuery("תקציב"))).toBe(true)
    expect(textMatchesQuery("שלום", normalizeQuery("תקציב"))).toBe(false)
  })
})

describe("memory engine visibility", () => {
  it("an owner sees shared and own private meetings, never W2", async () => {
    expect((await meetingIds(context("owner"), "תקציב")).sort()).toEqual(["m_budget", "m_hiring", "m_private"])
  })

  it("another member, a viewer and an ownerless API key never see the private meeting", async () => {
    for (const kind of ["member", "viewer", "key"] as const) {
      const ids = await meetingIds(context(kind), COLLIDING_TERM)

      expect(ids, kind).toEqual(["m_budget"])
    }
  })

  it("an API key sees private meetings of its creator only", async () => {
    expect((await meetingIds(context("key_owner"), COLLIDING_TERM)).sort()).toEqual(["m_budget", "m_private"])
  })

  it("W2 only sees its own meeting for the colliding term", async () => {
    expect(await meetingIds(context("w2"), COLLIDING_TERM)).toEqual(["m_w2"])
  })
})

describe("memory engine search", () => {
  it("finds prefixed Hebrew forms, Latin after ב-/ל-, short tokens and numbers", async () => {
    const ctx = context("member")

    expect(await meetingIds(ctx, "התקציב")).toContain("m_budget")
    expect(await meetingIds(ctx, "supabase")).toEqual(["m_budget"])
    expect(await meetingIds(ctx, "Q3")).toEqual(["m_budget"])
    expect(await meetingIds(ctx, "1200")).toEqual(["m_budget"])
    expect(await meetingIds(ctx, "דוח")).toEqual(["m_budget"])
  })

  it("applies filters: room, tag, date, participant, type, kind, speaker, language", async () => {
    const ctx = context("member")

    expect(await meetingIds(ctx, "תקציב", { roomIds: ["room_hr"] })).toEqual(["m_hiring"])
    expect(await meetingIds(ctx, "תקציב", { tags: ["FINANCE"] })).toEqual(["m_budget"])
    expect(await meetingIds(ctx, "תקציב", { from: "2026-08-15" })).toEqual(["m_budget"])
    expect(await meetingIds(ctx, "תקציב", { to: "2026-08-01" })).toEqual(["m_hiring"])
    expect(await meetingIds(ctx, "תקציב", { participants: ["דנה כהן"] })).toEqual(["m_budget"])
    expect(await meetingIds(ctx, "תקציב", { participants: ["יעל"] })).toEqual(["m_hiring"])
    expect(await meetingIds(ctx, "תקציב", { meetingTypes: ["board"] })).toEqual(["m_budget"])
    expect(await meetingIds(ctx, "תקציב", { sources: ["google_meet"] })).toEqual(["m_hiring"])
    expect(await meetingIds(ctx, "תקציב", { speakerIds: ["spk_dana"] })).toEqual(["m_budget"])
    expect(await meetingIds(ctx, "תקציב", { languages: ["en"] })).toEqual([])

    const kinds = await rankCandidates(ctx, { q: "תקציב", filters: { kinds: ["action_item"] }, task: "RETRIEVAL_QUERY", engine: createMemorySearchEngine() })

    expect(kinds.candidates.map((candidate) => candidate.chunk.kind)).toEqual(["action_item"])
  })

  it("serves searchWorkspace end to end with grouped hits, mode lexical and facets", async () => {
    const engine = createMemorySearchEngine()

    setSearchEngineForTesting(engine)

    try {
      const ctx = context("member")
      const response = await searchWorkspace(ctx, { q: "תקציב", filters: {}, group: "meeting", limit: 10, hitsPerMeeting: 10 })

      expect(response.mode).toBe("lexical")
      expect(response.degraded).toEqual(["no_vector"])
      expect(response.groups?.[0].meeting).toMatchObject({ id: "m_budget", meetingType: "board", rooms: [{ id: "room_fin", name: "כספים" }] })

      const hit = response.groups![0].hits.find((item) => item.kind === "transcript")!

      expect(hit.segmentId).toMatch(/^b/)
      expect(hit.speakerName).toBe("דנה")

      const facets = await engine.facets(ctx)

      expect(facets.rooms.map((room) => room.id).sort()).toEqual(["room_fin", "room_hr"])
      expect(facets.tags).toEqual(["finance", "hr"])
      expect(facets.meetingTypes).toEqual(["board"])
      expect(JSON.stringify(facets)).not.toContain("שיחה פרטית")
    } finally {
      setSearchEngineForTesting(undefined)
    }
  })

  it("uses an injected vector source and reports hybrid", async () => {
    const engine = createMemorySearchEngine({
      vectors: {
        key: { model: "replay", dimensions: 2 },
        chunkVector: (chunk) => (chunk.meetingId === "m_hiring" ? [1, 0] : [0, 1]),
        queryVector: () => [1, 0],
      },
    })
    const ranked = await rankCandidates(context("member"), { q: "מפתחים", filters: {}, task: "RETRIEVAL_QUERY", engine, config: searchConfig({}) })

    expect(ranked.mode).toBe("hybrid")
    expect(ranked.candidates[0].chunk.meetingId).toBe("m_hiring")
    expect(ranked.candidates[0].legs.vector?.similarity).toBeCloseTo(1, 6)
  })
})
