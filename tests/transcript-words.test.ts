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

  it("encodes edited words with a 6th slot and a null language slot (M4)", () => {
    const edited: TranscriptWord[] = [
      { startMs: 0, endMs: 400, text: "שלום", edited: true },
      { startMs: 400, endMs: 900, text: "Supabase", confidence: 0.7, language: "en", edited: true },
      { startMs: 900, endMs: 1200, text: "מחר", confidence: 0.9 },
    ]
    const encoded = encodeWords(edited, "he")

    expect(encoded).toEqual([
      [0, 400, "שלום", null, null, 1],
      [400, 900, "Supabase", 0.7, "en", 1],
      [900, 1200, "מחר", 0.9],
    ])
    expect(decodeWords(encoded)).toEqual(edited)
    expect(decodeWords(JSON.stringify(encoded))).toEqual(edited)
  })

  it("drops the edited flag when false and the language when equal to the segment's", () => {
    expect(
      encodeWords(
        [
          { startMs: 1, endMs: 2, text: "a", edited: false },
          { startMs: 2, endMs: 3, text: "b", language: "he", edited: true },
        ],
        "he"
      )
    ).toEqual([
      [1, 2, "a", null],
      [2, 3, "b", null, null, 1],
    ])
  })

  it("decodes 4-, 5- and 6-slot tuples and ignores unknown flag values", () => {
    expect(
      decodeWords([
        [0, 1, "four", 0.5],
        [1, 2, "five", null, "en"],
        [2, 3, "six", null, null, 1],
        [3, 4, "flag0", null, null, 0],
        [4, 5, "flagStr", null, "en", "1"],
      ])
    ).toEqual([
      { startMs: 0, endMs: 1, text: "four", confidence: 0.5 },
      { startMs: 1, endMs: 2, text: "five", language: "en" },
      { startMs: 2, endMs: 3, text: "six", edited: true },
      { startMs: 3, endMs: 4, text: "flag0" },
      { startMs: 4, endMs: 5, text: "flagStr", language: "en" },
    ])
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
