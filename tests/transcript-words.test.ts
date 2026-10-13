import { describe, expect, it } from "vitest"

import {
  decodeWords,
  encodeWords,
  type TranscriptWord,
} from "@/lib/meetings/transcript-words"

describe("transcript words encoding", () => {
  const words: TranscriptWord[] = [
    { startMs: 0, endMs: 420, text: "נבדוק", confidence: 0.91 },
    { startMs: 420, endMs: 900, text: "ב-Supabase", confidence: 0.8, language: "en" },
    { startMs: 950, endMs: 1300, text: "מחר" },
  ]

  it("round-trips words and omits the segment language", () => {
    const encoded = encodeWords(words, "he")

    expect(encoded).toEqual([
      [0, 420, "נבדוק", 0.91],
      [420, 900, "ב-Supabase", 0.8, "en"],
      [950, 1300, "מחר", null],
    ])
    expect(decodeWords(encoded)).toEqual(words)
  })

  it("drops a word language equal to the segment language", () => {
    const encoded = encodeWords([{ startMs: 1, endMs: 2, text: "hi", language: "en" }], "en")

    expect(encoded).toEqual([[1, 2, "hi", null]])
    expect(decodeWords(encoded)).toEqual([{ startMs: 1, endMs: 2, text: "hi" }])
  })

  it("rounds times to ms and confidence to 3 decimals", () => {
    expect(
      encodeWords([{ startMs: 10.6, endMs: 20.2, text: "a", confidence: 0.123456 }], "he")
    ).toEqual([[11, 20, "a", 0.123]])
  })

  it("survives a JSON round trip (jsonb text)", () => {
    expect(decodeWords(JSON.stringify(encodeWords(words, "he")))).toEqual(words)
  })

  it("decodes missing or malformed values leniently", () => {
    expect(decodeWords(null)).toEqual([])
    expect(decodeWords(undefined)).toEqual([])
    expect(decodeWords("not json")).toEqual([])
    expect(decodeWords({ words: [] })).toEqual([])
    expect(
      decodeWords([[0, 10, "ok", null], ["x", 1, "bad"], [1, 2], "junk", [5, 6, 7]])
    ).toEqual([{ startMs: 0, endMs: 10, text: "ok" }])
  })
})
