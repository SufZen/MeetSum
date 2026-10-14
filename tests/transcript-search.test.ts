import { describe, expect, it } from "vitest"

import {
  createSearchIndex,
  normalizeForSearch,
  searchIndex,
  searchTranscript,
  segmentSpeakerKey,
  stepMatch,
} from "@/lib/player/transcript-search"

describe("normalizeForSearch", () => {
  it("strips niqqud and maps offsets back to the original text", () => {
    const original = "שָׁלוֹם עוֹלָם"
    const normalized = normalizeForSearch(original)

    expect(normalized.text).toBe("שלומ עולמ")
    // "עולמ" starts at normalized 5 → original index of "ע"
    expect(original.slice(normalized.starts[5], normalized.ends[8])).toBe("עוֹלָם")
  })

  it("folds final letters, case, maqaf, geresh/gershayim and curly quotes", () => {
    expect(normalizeForSearch("ךםןףץ").text).toBe("כמנפצ")
    expect(normalizeForSearch("Due Diligence").text).toBe("due diligence")
    // M10 R12: the M6 normalizer turns maqaf into a space.
    expect(normalizeForSearch("בית־ספר").text).toBe("בית ספר")
    expect(normalizeForSearch("צה״ל").text).toBe(normalizeForSearch('צה"ל').text)
    expect(normalizeForSearch("ג׳ירפה").text).toBe(normalizeForSearch("ג'ירפה").text)
    expect(normalizeForSearch("“quote” ‘x’").text).toBe("\"quote\" 'x'")
  })

  it("decomposes compatibility forms (NFKC/NFKD) such as Hebrew presentation forms", () => {
    // U+FB2A HEBREW LETTER SHIN WITH SHIN DOT
    expect(normalizeForSearch("שׁלום").text).toBe("שלומ")
    expect(normalizeForSearch("ﬁle").text).toBe("file")
  })
})

const segments = [
  { id: "s1", speaker: "Speaker 1", speakerId: "a", text: "נדבר על הַתַּקְצִיב של Lisboa" },
  { id: "s2", speaker: "Speaker 2", speakerId: "b", text: "התקציב אושר, lisboa riverside" },
  { id: "s3", speaker: "Dana", text: "אין שינוי בתקציב" },
]

describe("searchTranscript", () => {
  it("finds niqqud-insensitive, case-insensitive substrings with original offsets", () => {
    const matches = searchTranscript(segments, "תקציב")

    expect(matches.map((match) => match.segmentId)).toEqual(["s1", "s2", "s3"])
    const first = matches[0]

    expect(segments[0].text.slice(first.start, first.end)).toBe("תַּקְצִיב")
    expect(searchTranscript(segments, "LISBOA").map((match) => match.segmentId)).toEqual(["s1", "s2"])
  })

  it("finds every occurrence inside a segment", () => {
    const matches = searchTranscript([{ id: "x", speaker: "S", text: "go go gone" }], "go")

    expect(matches.map((match) => [match.start, match.end])).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
    ])
    expect(matches.map((match) => match.matchIndex)).toEqual([0, 1, 2])
  })

  it("matches final-letter variants of the query", () => {
    expect(searchTranscript([{ id: "x", speaker: "S", text: "שלום לכם" }], "שלומ")).toHaveLength(1)
    expect(searchTranscript([{ id: "x", speaker: "S", text: "שלומית" }], "שלום")).toHaveLength(1)
  })

  it("filters by speaker id or legacy label key", () => {
    expect(
      searchTranscript(segments, "תקציב", { speakerKeys: new Set(["b"]) }).map((m) => m.segmentId)
    ).toEqual(["s2"])
    expect(
      searchTranscript(segments, "תקציב", { speakerKeys: new Set([segmentSpeakerKey(segments[2])]) }).map(
        (m) => m.segmentId
      )
    ).toEqual(["s3"])
  })

  it("returns nothing for a blank query", () => {
    expect(searchTranscript(segments, "   ")).toEqual([])
  })

  it("reuses a prebuilt index", () => {
    const index = createSearchIndex(segments)

    expect(searchIndex(index, "riverside")).toHaveLength(1)
    expect(searchIndex(index, "riverside")[0].segmentIndex).toBe(1)
  })
})

describe("stepMatch", () => {
  it("wraps forwards and backwards", () => {
    expect(stepMatch(0, 3, 1)).toBe(1)
    expect(stepMatch(2, 3, 1)).toBe(0)
    expect(stepMatch(0, 3, -1)).toBe(2)
    expect(stepMatch(-1, 3, 1)).toBe(0)
    expect(stepMatch(-1, 3, -1)).toBe(2)
    expect(stepMatch(0, 0, 1)).toBe(-1)
  })
})
