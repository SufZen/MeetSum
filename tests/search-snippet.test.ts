import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/search/hebrew-normalize", async () => (await import("./helpers/search-doubles")).normalizerDouble)

import { normalizeQuery } from "@/lib/search/hebrew-normalize"
import { buildSnippet, findMatches, pickCitationSegment } from "@/lib/search/snippet"

function marked(snippet: string, highlights: [number, number][]) {
  return highlights.map(([start, end]) => snippet.slice(start, end))
}

describe("buildSnippet", () => {
  it("returns the offset of the match shown in the snippet, not of the first match in the chunk", () => {
    // One lone early match, then a dense cluster later: the snippet shows the cluster.
    const filler = " מילים אחרות לגמרי".repeat(30)
    const text = `רון: תקציב.${filler}\nדנה: תקציב ועוד תקציב ושוב תקציב`
    const result = buildSnippet(text, normalizeQuery("תקציב"), { window: 60 })
    const cluster = text.lastIndexOf("דנה: ") + "דנה: ".length

    expect(result.snippet).toContain("ועוד תקציב")
    expect(result.matchOffset).toBe(cluster)
  })

  it("highlights the whole prefixed surface word for a bare query", () => {
    const text = "דנה: אנחנו צריכים לדון בתקציב של הרבעון והתקציב השנתי"
    const result = buildSnippet(text, normalizeQuery("תקציב"))

    expect(marked(result.snippet, result.highlights)).toEqual(["בתקציב", "והתקציב"])
  })

  it("matches a prefixed query against the bare word", () => {
    const result = buildSnippet("התקציב אושר", normalizeQuery("בתקציב"))

    expect(marked(result.snippet, result.highlights)).toEqual(["התקציב"])
  })

  it("maps highlights across niqqud and final letters onto the original text", () => {
    const text = "אמרנו שהתַּקְצִיב יעלה ושלום לכם"
    const result = buildSnippet(text, normalizeQuery("תקציב שלומ"))

    expect(marked(result.snippet, result.highlights)).toEqual(["שהתַּקְצִיב", "ושלום"])
  })

  it("keeps UTF-16 offsets correct around surrogate pairs", () => {
    const text = "🎉🎉 launch day 🚀 בתקציב"
    const result = buildSnippet(text, normalizeQuery("launch תקציב"))

    expect(marked(result.snippet, result.highlights)).toEqual(["launch", "בתקציב"])
  })

  it("picks the densest window, snaps to words and adds ellipses", () => {
    const filler = "מילה ".repeat(80)
    const text = `${filler}כאן התקציב והתקציב ולתקציב ${filler}`
    const result = buildSnippet(text, normalizeQuery("תקציב"), { window: 60 })

    expect(result.snippet.startsWith("…")).toBe(true)
    expect(result.snippet.endsWith("…")).toBe(true)
    expect(result.snippet.length).toBeLessThanOrEqual(62)
    expect(marked(result.snippet, result.highlights)).toEqual(["התקציב", "והתקציב", "ולתקציב"])
    expect(result.snippet).not.toMatch(/…\s|\s…/)
    expect(result.snippet.slice(1, -1).split(" ").every((word) => text.includes(word))).toBe(true)
    expect(result.matchOffset).toBe(text.indexOf("התקציב"))
  })

  it("returns the head of the text when nothing matches", () => {
    const result = buildSnippet("שלום עולם", normalizeQuery("xyz"))

    expect(result).toMatchObject({ snippet: "שלום עולם", highlights: [], matchOffset: undefined })
  })

  it("treats snippet text as plain text", () => {
    const result = buildSnippet("<img src=x onerror=alert(1)> budget", normalizeQuery("budget"))

    expect(result.snippet).toContain("<img")
    expect(marked(result.snippet, result.highlights)).toEqual(["budget"])
  })
})

describe("findMatches", () => {
  it("supports prefix (:*) matching for plurals but not for short tokens", () => {
    expect(findMatches("תקציבים חדשים", normalizeQuery("תקציב")).length).toBe(1)
    expect(findMatches("עלות", normalizeQuery("על")).length).toBe(0)
    expect(findMatches("דיברנו על זה", normalizeQuery("על")).length).toBe(1)
  })
})

describe("pickCitationSegment", () => {
  const chunk = {
    segmentIds: ["s1", "s2", "s3", "s4"],
    segmentStartMs: [0, 1000, 2000, 3000],
    segmentOffsets: [0, 20, 40, 60],
    overlapCount: 1,
  }

  it("returns the own segment containing the offset", () => {
    expect(pickCitationSegment(chunk, 45)).toEqual({ segmentId: "s3", startMs: 2000 })
    expect(pickCitationSegment(chunk, 99)).toEqual({ segmentId: "s4", startMs: 3000 })
  })

  it("skips overlap segments", () => {
    expect(pickCitationSegment(chunk, 5)).toEqual({ segmentId: "s2", startMs: 1000 })
    expect(pickCitationSegment(chunk, undefined)).toEqual({ segmentId: "s2", startMs: 1000 })
  })

  it("is undefined without segments", () => {
    expect(pickCitationSegment({ segmentIds: [], segmentStartMs: [], segmentOffsets: [], overlapCount: 0 }, 3)).toBeUndefined()
  })
})
