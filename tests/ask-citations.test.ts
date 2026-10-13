import { describe, expect, it } from "vitest"

import {
  buildCitations,
  createMarkerStream,
  normalizeMarkers,
  quoteOf,
  type AliasMap,
} from "@/lib/ask/citations"

/** Citation markers (docs/parity/m6.md, C4 tests). */

const aliases: AliasMap = {
  s1: { alias: "s1", meetingId: "m1", meetingTitle: "תקציב", segmentId: "seg_1", startMs: 1000, kind: "transcript", speakerName: "דנה", quote: "התקציב אושר" },
  s12: { alias: "s12", meetingId: "m1", meetingTitle: "תקציב", segmentId: "seg_12", startMs: 12000, kind: "transcript", quote: "נדחה לרבעון הבא" },
  a1: { alias: "a1", meetingId: "m2", meetingTitle: "גיוס", segmentId: "seg_9", startMs: 9000, kind: "item", quote: "החלטה: לגייס" },
}

describe("normalizeMarkers", () => {
  it("drops unknown aliases and rewrites groups", () => {
    expect(normalizeMarkers("התקציב אושר [s1, s99][S12] וגם [s7].", aliases)).toBe("התקציב אושר [s1][s12] וגם .")
    expect(normalizeMarkers("[a1; s1]", aliases)).toBe("[a1][s1]")
  })

  it("leaves non-marker brackets alone", () => {
    expect(normalizeMarkers("[note] [x1]", aliases)).toBe("[note] [x1]")
  })
})

describe("buildCitations", () => {
  it("numbers chips by first appearance and takes the quote from the alias entry", () => {
    const citations = buildCitations("A [s12]. B [s1][s12]. C [a1] [s404].", aliases)

    expect(citations.map((citation) => [citation.n, citation.alias])).toEqual([
      [1, "s12"],
      [2, "s1"],
      [3, "a1"],
    ])
    expect(citations[1]).toMatchObject({ meetingId: "m1", segmentId: "seg_1", startMs: 1000, quote: "התקציב אושר", speakerName: "דנה" })
  })

  it("never uses a model-written quote", () => {
    const citations = buildCitations('דנה אמרה "המצאתי ציטוט" [s1]', aliases)

    expect(citations[0].quote).toBe("התקציב אושר")
  })
})

describe("createMarkerStream", () => {
  it("holds a marker split across deltas until it closes", () => {
    const stream = createMarkerStream(aliases)
    const out = [stream.push("התקציב אושר ["), stream.push("s"), stream.push("12"), stream.push("] והמשך"), stream.flush()]

    expect(out.join("")).toBe("התקציב אושר [s12] והמשך")
    expect(out[0]).toBe("התקציב אושר ")
    expect(out[1]).toBe("")
  })

  it("drops an unknown alias split across deltas", () => {
    const stream = createMarkerStream(aliases)

    expect([stream.push("x [s9"), stream.push("9] y"), stream.flush()].join("")).toBe("x  y")
  })

  it("releases a bracket that turns out not to be a marker", () => {
    const stream = createMarkerStream(aliases)

    expect(stream.push("a [")).toBe("a ")
    expect(stream.push("note] b")).toBe("[note] b")
  })
})

describe("quoteOf", () => {
  it("caps quotes at 160 characters on a word boundary", () => {
    const quote = quoteOf("מילה ".repeat(80))

    expect(quote.length).toBeLessThanOrEqual(160)
    expect(quote.endsWith("…")).toBe(true)
  })
})
