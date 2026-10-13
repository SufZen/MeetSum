import { afterEach, describe, expect, it, vi } from "vitest"

import { threadsQuery } from "@/components/ask/use-threads"
import { EMPTY_FACETS, readFacets } from "@/components/search/use-facets"
import { appendGroups, fetchSearch, SearchHttpError, searchErrorOf } from "@/components/search/use-search"
import { EMPTY_SEARCH_STATE } from "@/lib/client/search-url"
import type { SearchMeetingGroup } from "@/lib/search/types"

const group = (id: string): SearchMeetingGroup => ({
  meeting: { id, title: id, startedAt: "2026-10-01T10:00:00Z", source: "upload", tags: [], rooms: [] },
  score: 1,
  hits: [],
})

describe("search client data", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("requests grouped results with the page size, hits and cursor", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ mode: "hybrid", groups: [], nextCursor: null })))

    vi.stubGlobal("fetch", fetchMock)
    await fetchSearch({ ...EMPTY_SEARCH_STATE, q: "תקציב", rooms: ["r1"] }, { cursor: "c2" })

    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), "http://x")

    expect(url.pathname).toBe("/api/search")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "תקציב",
      room: "r1",
      group: "meeting",
      limit: "10",
      hits: "3",
      cursor: "c2",
    })
  })

  it("throws on a failed search so the page shows the error state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })))

    await expect(fetchSearch({ ...EMPTY_SEARCH_STATE, q: "x" }, {})).rejects.toThrow()
  })

  it("reports a 429 as rate_limited with the Retry-After seconds (not a connection problem)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "12" } })))

    const error = await fetchSearch({ ...EMPTY_SEARCH_STATE, q: "x" }, {}).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SearchHttpError)
    expect(searchErrorOf(error)).toEqual({ kind: "rate_limited", retryAfterSec: 12 })
    expect(searchErrorOf(new SearchHttpError(429, undefined))).toEqual({ kind: "rate_limited" })
    expect(searchErrorOf(new SearchHttpError(503, undefined))).toEqual({ kind: "unavailable" })
    expect(searchErrorOf(new TypeError("fetch failed"))).toEqual({ kind: "failed" })
  })

  it("appends the next page without repeating meetings", () => {
    expect(appendGroups([group("a"), group("b")], [group("b"), group("c")]).map((item) => item.meeting.id)).toEqual([
      "a",
      "b",
      "c",
    ])
    expect(appendGroups([group("a")], undefined)).toHaveLength(1)
  })

  it("reads facets bare or wrapped and tolerates missing lists", () => {
    expect(readFacets({ tags: ["כספים"] })).toEqual({ ...EMPTY_FACETS, tags: ["כספים"] })
    expect(readFacets({ facets: { rooms: [{ id: "r", name: "R" }] } }).rooms).toEqual([{ id: "r", name: "R" }])
    expect(readFacets(null)).toEqual(EMPTY_FACETS)
    expect(readFacets({ people: "nope" }).people).toEqual([])
  })

  it("filters thread lists by scope", () => {
    expect(threadsQuery({ kind: "meeting", meetingId: "m 1" })).toBe("scope=meeting&meetingId=m+1&limit=50")
    expect(threadsQuery({ kind: "room", roomId: "r1" })).toBe("scope=room&roomId=r1&limit=50")
    expect(threadsQuery({ kind: "workspace" })).toBe("scope=workspace&limit=50")
  })
})
