import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

import { GET } from "@/app/api/meetings/search/route"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { setRateLimitStoreForTesting } from "@/lib/rate-limit"
import { createMemorySearchEngine } from "@/lib/search/memory-engine"
import { setSearchEngineForTesting } from "@/lib/search/service"

/**
 * GET /api/meetings/search (legacy compat route) over the real M6 stack: the
 * route, the scoped repository, B's search service and the memory engine with
 * A's real chunker and normalizer. No local copy of the search logic.
 */

type Result = {
  id: string
  title: string
  status: string
  source: string
  overview: string
  participantCount: number
  tags: string[]
  isFavorite: boolean
}

let database: InMemoryMeetingDatabase

function seed() {
  return createInMemoryMeetingDatabase([
    testMeeting({
      id: "m1",
      title: "Engineering Standup",
      language: "en",
      startedAt: "2026-05-28T09:00:00Z",
      source: "google_meet",
      participants: ["Alice", "Bob"],
      summary: { overview: "Discussed Sprint 5 progress.", decisions: [], actionItems: [] },
      tags: ["technical", "product"],
    }),
    testMeeting({
      id: "m2",
      title: "Sales Pipeline Review",
      language: "en",
      startedAt: "2026-05-28T14:00:00Z",
      source: "upload",
      participants: ["Charlie", "Diana"],
      summary: { overview: "Reviewed Q3 sales pipeline targets.", decisions: [], actionItems: [] },
      tags: ["sales", "follow-up-needed"],
      transcript: [
        { id: "seg_m2_1", speaker: "Charlie", startMs: 0, endMs: 4000, text: "The renewal forecast looks strong this quarter." },
      ],
    }),
    testMeeting({
      id: "m3",
      title: "Product Design Workshop",
      language: "en",
      status: "summarizing",
      startedAt: "2026-05-27T10:00:00Z",
      source: "google_meet",
      participants: ["Alice", "Eve"],
      tags: ["product", "technical"],
    }),
    testMeeting({
      id: "m_private",
      title: "Private Standup Notes",
      language: "en",
      visibility: "private",
      ownerUserId: "user_owner",
      summary: { overview: "Standup about compensation.", decisions: [], actionItems: [] },
    }),
    testMeeting({
      id: "m_w2",
      title: "Engineering Standup W2",
      language: "en",
      workspaceId: "ws_b",
      summary: { overview: "Other workspace standup.", decisions: [], actionItems: [] },
    }),
  ])
}

async function search(query: string): Promise<{ status: number; meetings: Result[] }> {
  const response = await GET(new Request(`http://localhost/api/meetings/search?${query}`), routeParams({}))
  const body = await response.json()

  return { status: response.status, meetings: body.meetings ?? [] }
}

const ids = (meetings: Result[]) => meetings.map((meeting) => meeting.id).sort()

beforeEach(async () => {
  database = seed()
  setRateLimitStoreForTesting(new Map())
  setSearchEngineForTesting(createMemorySearchEngine())
  setRouteCtx(await createTestCtx({ database, userId: "user_me", workspaceId: "ws_a" }))
})

afterEach(() => {
  setRouteCtx(undefined)
  setSearchEngineForTesting(undefined)
  setRateLimitStoreForTesting(undefined)
})

describe("GET /api/meetings/search (real route and search service)", () => {
  it("finds meetings by title keyword, only in the caller's workspace and visibility", async () => {
    const { status, meetings } = await search("q=standup")

    expect(status).toBe(200)
    expect(ids(meetings)).toEqual(["m1"])
  })

  it("finds meetings by summary overview text", async () => {
    expect(ids((await search("q=Q3%20sales")).meetings)).toContain("m2")
  })

  it("finds meetings by transcript text (M6 index)", async () => {
    expect(ids((await search("q=renewal%20forecast")).meetings)).toEqual(["m2"])
  })

  it("filters by tag, source and status", async () => {
    expect(ids((await search("tag=sales")).meetings)).toEqual(["m2"])
    expect(ids((await search("q=review&source=upload")).meetings)).toEqual(["m2"])
    expect(ids((await search("status=summarizing")).meetings)).toEqual(["m3"])
  })

  it("respects limit and keeps the response shape", async () => {
    const { meetings } = await search("status=completed&limit=1")

    expect(meetings).toHaveLength(1)

    const [standup] = (await search("q=standup")).meetings

    expect(standup).toMatchObject({
      id: "m1",
      title: "Engineering Standup",
      source: "google_meet",
      overview: "Discussed Sprint 5 progress.",
      participantCount: 2,
      tags: ["technical", "product"],
    })
    expect(typeof standup.isFavorite).toBe("boolean")
  })

  it("returns nothing for no matches and 400 without parameters", async () => {
    expect((await search("q=nonexistentterm")).meetings).toEqual([])
    expect((await search("")).status).toBe(400)
  })
})
