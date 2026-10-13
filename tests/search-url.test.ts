import { describe, expect, it } from "vitest"

import {
  EMPTY_SEARCH_STATE,
  buildSearchApiParams,
  clearFilters,
  datePresetRange,
  hasActiveFilters,
  isSearchable,
  parseSearchUrl,
  searchKey,
  serializeSearchUrl,
  toggleListValue,
  type SearchUrlState,
} from "@/lib/client/search-url"

const full: SearchUrlState = {
  q: "תקציב Q3",
  from: "2026-09-01",
  to: "2026-09-30",
  participants: ["דנה", "ran@example.com"],
  rooms: ["room-1"],
  tags: ["כספים"],
  languages: ["he", "mixed"],
  meetingTypes: ["board"],
  kinds: ["transcript", "action_item"],
  tab: "search",
}

describe("search URL state", () => {
  it("round-trips every field through the query string", () => {
    const query = serializeSearchUrl(full)

    expect(parseSearchUrl(query)).toEqual(full)
    expect(parseSearchUrl(`?${query}`)).toEqual(full)
  })

  it("serializes nothing for the empty state", () => {
    expect(serializeSearchUrl(EMPTY_SEARCH_STATE)).toBe("")
    expect(parseSearchUrl("")).toEqual(EMPTY_SEARCH_STATE)
  })

  it("uses the API's repeatable parameter names", () => {
    const params = new URLSearchParams(serializeSearchUrl(full))

    expect(params.getAll("participant")).toEqual(["דנה", "ran@example.com"])
    expect(params.getAll("room")).toEqual(["room-1"])
    expect(params.getAll("type")).toEqual(["board"])
    expect(params.getAll("kind")).toEqual(["transcript", "action_item"])
  })

  it("drops unknown languages and kinds, invalid dates and duplicates", () => {
    const state = parseSearchUrl(
      "language=he&language=fr&language=he&kind=meta&kind=summary&kind=bogus&from=2026-02-30&to=yesterday&tag=a&tag=a"
    )

    expect(state.languages).toEqual(["he"])
    expect(state.kinds).toEqual(["summary"])
    expect(state.from).toBeUndefined()
    expect(state.to).toBeUndefined()
    expect(state.tags).toEqual(["a"])
  })

  it("caps the query at 300 characters", () => {
    expect(parseSearchUrl({ q: "א".repeat(400) }).q).toHaveLength(300)
  })

  it("keeps a date preset instead of explicit dates", () => {
    const state = parseSearchUrl("range=30&from=2026-01-01&to=2026-01-02")

    expect(state.range).toBe("30")
    expect(state.from).toBeUndefined()
    expect(serializeSearchUrl(state)).toBe("range=30")
    expect(parseSearchUrl("range=12").range).toBeUndefined()
  })

  it("keeps the Ask tab in the URL", () => {
    const state = parseSearchUrl("tab=ask&q=x")

    expect(state.tab).toBe("ask")
    expect(serializeSearchUrl(state)).toBe("q=x&tab=ask")
    expect(searchKey(state)).toBe("q=x")
  })

  it("computes inclusive preset ranges", () => {
    expect(datePresetRange("7", new Date("2026-10-13T22:00:00Z"))).toEqual({
      from: "2026-10-07",
      to: "2026-10-13",
    })
  })

  it("builds API params with the preset resolved, group, limit and cursor", () => {
    const params = buildSearchApiParams(
      { ...EMPTY_SEARCH_STATE, q: " תקציב ", range: "7", rooms: ["r1"] },
      { group: "meeting", limit: 10, hits: 3, cursor: "abc", now: new Date("2026-10-13T08:00:00Z") }
    )

    expect(Object.fromEntries(params)).toEqual({
      q: "תקציב",
      from: "2026-10-07",
      to: "2026-10-13",
      room: "r1",
      group: "meeting",
      limit: "10",
      hits: "3",
      cursor: "abc",
    })
  })

  it("knows when filters are active and clears only them", () => {
    expect(hasActiveFilters(EMPTY_SEARCH_STATE)).toBe(false)
    expect(hasActiveFilters(full)).toBe(true)
    expect(clearFilters({ ...full, tab: "ask" })).toEqual({ ...EMPTY_SEARCH_STATE, q: full.q, tab: "ask" })
  })

  it("is searchable with a query or with filters alone", () => {
    expect(isSearchable(EMPTY_SEARCH_STATE)).toBe(false)
    expect(isSearchable({ ...EMPTY_SEARCH_STATE, q: "  " })).toBe(false)
    expect(isSearchable({ ...EMPTY_SEARCH_STATE, rooms: ["r"] })).toBe(true)
  })

  it("toggles list values", () => {
    expect(toggleListValue(["a"], "b")).toEqual(["a", "b"])
    expect(toggleListValue(["a", "b"], "a")).toEqual(["b"])
  })
})
