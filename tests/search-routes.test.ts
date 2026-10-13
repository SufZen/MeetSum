import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, routeParams, setRouteCtx } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})
vi.mock("@/lib/search/hebrew-normalize", async () => (await import("./helpers/search-doubles")).normalizerDouble)
vi.mock("@/lib/search/chunker", async () => (await import("./helpers/search-doubles")).chunkerDouble)
vi.mock("@/lib/search/chunk-sources", async () => (await import("./helpers/search-doubles")).chunkSourcesDouble)

import { GET as legacySearch } from "@/app/api/meetings/search/route"
import { GET as memorySearch } from "@/app/api/memory/search/route"
import { GET as facets } from "@/app/api/search/facets/route"
import { GET as search } from "@/app/api/search/route"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { SearchUnavailableError } from "@/lib/search/errors"
import { setSearchEngineForTesting, type SearchEngine } from "@/lib/search/service"
import type { SearchFacets, SearchResponse } from "@/lib/search/types"
import type { WorkspaceRole } from "@/lib/workspaces/types"

import { COLLIDING_TERM, searchCorpus } from "./helpers/search-fixtures"

const BASE = "http://localhost/api"
let database: InMemoryMeetingDatabase

type Who = { role?: WorkspaceRole; userId?: string; workspaceId?: string; principal?: "user" | "api_key"; apiKeyCreatedBy?: string }

async function as(who: Who = {}) {
  setRouteCtx(await createTestCtx({ role: who.role ?? "member", userId: who.userId ?? "user_other", workspaceId: who.workspaceId ?? "ws_a", principal: who.principal, apiKeyCreatedBy: who.apiKeyCreatedBy, database }))
}

const get = (handler: typeof search, path: string) => handler(new Request(`${BASE}${path}`), routeParams({}))

async function searchBody(path: string): Promise<SearchResponse> {
  const response = await get(search, path)

  expect(response.status).toBe(200)

  return response.json()
}

function ids(body: SearchResponse) {
  return [...new Set([...(body.groups ?? []).map((group) => group.meeting.id), ...(body.hits ?? []).map((hit) => hit.meetingId)])].sort()
}

beforeEach(() => {
  database = createInMemoryMeetingDatabase(searchCorpus())
  setSearchEngineForTesting(undefined)
  delete process.env.MEETSUM_STORAGE
})

afterEach(() => setRouteCtx(undefined))

describe("GET /api/search authz and validation", () => {
  it("answers 401 without a principal", async () => {
    setRouteCtx(undefined)

    expect((await get(search, "/search?q=x")).status).toBe(401)
    expect((await get(facets, "/search/facets")).status).toBe(401)
  })

  it("rejects an over-long q, unknown kind/language/group and bad dates with 400", async () => {
    await as()

    for (const path of [
      `/search?q=${"א".repeat(301)}`,
      "/search?q=x&kind=secret",
      "/search?q=x&language=fr",
      "/search?q=x&group=everything",
      "/search?q=x&from=2026-13-01",
      "/search?q=x&limit=abc",
    ]) {
      expect((await get(search, path)).status, path).toBe(400)
    }
  })

  it("answers 503 when every search leg fails (statement timeout)", async () => {
    await as()

    const failing: SearchEngine = {
      kind: "pg",
      capabilities: async () => ({ vector: false, trgm: true, embeddingKey: null }),
      runLegs: async () => {
        throw new SearchUnavailableError()
      },
      hydrate: async () => [],
      listMeetings: async () => ({ meetings: [], total: 0 }),
      countPending: async () => undefined,
      segmentTexts: async () => ({}),
      facets: async () => ({ people: [], speakers: [], rooms: [], tags: [], languages: [], meetingTypes: [], sources: [] }),
    }

    setSearchEngineForTesting(failing)

    expect((await get(search, "/search?q=תקציב")).status).toBe(503)
    expect((await get(memorySearch, "/memory/search?query=תקציב")).status).toBe(503)
    expect((await get(legacySearch, "/meetings/search?q=תקציב")).status).toBe(503)
  })

  it("answers 400 for a tampered or foreign cursor", async () => {
    await as()

    const first = await searchBody("/search?q=תקציב&group=chunk&limit=1")

    expect(first.nextCursor).toBeTruthy()
    expect((await get(search, `/search?q=אחר&group=chunk&limit=1&cursor=${first.nextCursor}`)).status).toBe(400)
    expect((await get(search, "/search?q=תקציב&group=chunk&limit=1&cursor=garbage")).status).toBe(400)

    const next = await searchBody(`/search?q=תקציב&group=chunk&limit=1&cursor=${first.nextCursor}`)

    expect(next.hits?.[0].chunkId).not.toBe(first.hits?.[0].chunkId)
  })
})

describe("GET /api/search visibility", () => {
  it("a W1 member and a viewer never see the private meeting or W2", async () => {
    for (const role of ["member", "viewer"] as const) {
      await as({ role })

      expect(ids(await searchBody(`/search?q=${COLLIDING_TERM}`)), role).toEqual(["m_budget"])
      expect(ids(await searchBody("/search?q=תקציב&group=chunk&limit=50")), role).toEqual(["m_budget", "m_hiring"])
    }
  })

  it("the private meeting's owner sees it", async () => {
    await as({ userId: "user_owner", role: "owner" })

    expect(ids(await searchBody(`/search?q=${COLLIDING_TERM}`))).toEqual(["m_budget", "m_private"])
  })

  it("an API key sees private meetings only of its creator", async () => {
    await as({ principal: "api_key" })
    expect(ids(await searchBody(`/search?q=${COLLIDING_TERM}`))).toEqual(["m_budget"])

    await as({ principal: "api_key", apiKeyCreatedBy: "user_owner" })
    expect(ids(await searchBody(`/search?q=${COLLIDING_TERM}`))).toEqual(["m_budget", "m_private"])
  })

  it("W2 sees only its own meeting for the colliding term, even when filtering by W1 ids", async () => {
    await as({ workspaceId: "ws_b", userId: "user_w2", role: "owner" })

    expect(ids(await searchBody(`/search?q=${COLLIDING_TERM}`))).toEqual(["m_w2"])
    expect(ids(await searchBody(`/search?q=${COLLIDING_TERM}&meetingId=m_budget&meetingId=m_private`))).toEqual([])
  })

  it("facets come from visible meetings only", async () => {
    await as()

    const response = await get(facets, "/search/facets")
    const body = (await response.json()) as SearchFacets

    expect(response.status).toBe(200)
    expect(body.rooms.map((room) => room.id).sort()).toEqual(["room_fin", "room_hr"])
    expect(JSON.stringify(body)).not.toMatch(/Workspace B|שיחה פרטית/)

    await as({ workspaceId: "ws_b", userId: "user_w2", role: "owner" })

    const w2 = (await (await get(facets, "/search/facets")).json()) as SearchFacets

    expect(w2.rooms).toEqual([])
    expect(w2.tags).toEqual([])
  })
})

describe("GET /api/search results", () => {
  it("groups by meeting with snippets, highlights and filters from repeatable params", async () => {
    await as()

    const body = await searchBody("/search?q=תקציב&room=room_fin&tag=finance&hits=10")

    expect(body.mode).toBe("lexical")
    expect(body.degraded).toEqual(["no_vector"])
    expect(body.groups?.map((group) => group.meeting.id)).toEqual(["m_budget"])

    const transcript = body.groups![0].hits.find((hit) => hit.kind === "transcript")!

    expect(transcript.snippet.slice(...transcript.highlights[0])).toMatch(/תקציב/)
    expect(transcript.segmentId).toMatch(/^b/)

    const both = await searchBody("/search?q=תקציב&room=room_fin&room=room_hr")

    expect(ids(both)).toEqual(["m_budget", "m_hiring"])

    const typed = await searchBody("/search?q=תקציב&type=board&kind=action_item&group=chunk")

    expect(typed.hits?.map((hit) => hit.kind)).toEqual(["action_item"])
  })

  it("lists meetings for an empty q with filters", async () => {
    await as()

    const body = await searchBody("/search?room=room_hr")

    expect(body.groups?.map((group) => group.meeting.id)).toEqual(["m_hiring"])
    expect(body.groups?.[0].hits).toEqual([])
  })
})

describe("compat routes keep their shapes", () => {
  it("/api/meetings/search returns the legacy shape and only visible meetings", async () => {
    await as()

    const response = await get(legacySearch, `/meetings/search?q=${COLLIDING_TERM}`)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(["meetings", "query", "total"])
    expect(body.query).toEqual({ q: COLLIDING_TERM })
    expect(body.meetings.map((meeting: { id: string }) => meeting.id)).toEqual(["m_budget"])
    expect(Object.keys(body.meetings[0]).sort()).toEqual(
      ["id", "isFavorite", "language", "overview", "participantCount", "source", "startedAt", "status", "tags", "title"].sort()
    )
    expect((await get(legacySearch, "/meetings/search")).status).toBe(400)
    expect((await (await get(legacySearch, "/meetings/search?tag=finance")).json()).meetings.map((m: { id: string }) => m.id)).toEqual(["m_budget"])
    expect((await (await get(legacySearch, "/meetings/search?status=completed")).json()).total).toBe(2)
  })

  it("/api/memory/search returns {results} with a Deprecation header", async () => {
    await as()

    const response = await get(memorySearch, "/memory/search?query=תקציב&roomId=room_fin")
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get("Deprecation")).toBe("true")
    expect(body.results.map((result: { id: string }) => result.id)).toEqual(["m_budget"])
    expect(Object.keys(body.results[0]).sort()).toEqual(
      ["actionItems", "id", "matchCount", "matches", "overview", "startedAt", "status", "tags", "title", "transcriptMatches"].sort()
    )
    expect(body.results[0].matches[0]).toMatchObject({ meetingId: "m_budget", meetingTitle: "ישיבת תקציב רבעונית" })

    const all = await (await get(memorySearch, `/memory/search?query=${COLLIDING_TERM}`)).json()

    expect(all.results.map((result: { id: string }) => result.id)).toEqual(["m_budget"])
  })
})
