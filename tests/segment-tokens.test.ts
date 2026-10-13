import { describe, expect, it } from "vitest"

import { buildSegmentTokens, groupLanguageRuns } from "@/lib/player/segment-tokens"

const w = (startMs: number, text: string, language?: string) => ({
  startMs,
  endMs: startMs + 200,
  text,
  ...(language ? { language } : {}),
})

describe("buildSegmentTokens", () => {
  it("splits text into words and whitespace without words", () => {
    const tokens = buildSegmentTokens("שלום  לכולם")

    expect(tokens.map((token) => token.text)).toEqual(["שלום", "  ", "לכולם"])
    expect(tokens.every((token) => token.wordIndex === undefined)).toBe(true)
    expect(tokens[1].whitespace).toBe(true)
  })

  it("assigns word indexes one-to-one when counts match", () => {
    const tokens = buildSegmentTokens("נכנסים ל-due diligence", [
      w(0, "נכנסים"),
      w(300, "ל-due", "en"),
      w(600, "diligence", "en"),
    ])
    const words = tokens.filter((token) => !token.whitespace)

    expect(words.map((token) => token.wordIndex)).toEqual([0, 1, 2])
    expect(words.map((token) => token.lang)).toEqual([undefined, "en", "en"])
    expect(tokens.map((token) => token.text).join("")).toBe("נכנסים ל-due diligence")
  })

  it("aligns by folded equality when an edit changed the token count", () => {
    const tokens = buildSegmentTokens("שלום, חברים יקרים", [w(0, "שלום"), w(300, "יקרים")])
    const words = tokens.filter((token) => !token.whitespace)

    expect(words.map((token) => [token.text, token.wordIndex])).toEqual([
      ["שלום,", 0],
      ["חברים", undefined],
      ["יקרים", 1],
    ])
  })

  it("splits tokens at search-mark boundaries and keeps the word index", () => {
    const tokens = buildSegmentTokens("התקציב אושר", [w(0, "התקציב"), w(300, "אושר")], [
      { start: 1, end: 6, matchIndex: 4 },
    ])

    expect(tokens.map((token) => [token.text, token.wordIndex, token.markIndex])).toEqual([
      ["ה", 0, undefined],
      ["תקציב", 0, 4],
      [" ", undefined, undefined],
      ["אושר", 1, undefined],
    ])
  })

  it("keeps original offsets on every token", () => {
    const tokens = buildSegmentTokens("a bb", undefined)

    expect(tokens.map((token) => [token.start, token.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 4],
    ])
  })
})

describe("groupLanguageRuns", () => {
  it("joins consecutive foreign-language tokens (and the spaces between them) into one run", () => {
    const tokens = buildSegmentTokens("נכנסים ל due diligence היום", [
      w(0, "נכנסים"),
      w(100, "ל"),
      w(200, "due", "en"),
      w(300, "diligence", "en"),
      w(400, "היום"),
    ])
    const runs = groupLanguageRuns(tokens)

    expect(runs.map((run) => [run.lang, run.tokens.map((token) => token.text).join("")])).toEqual([
      [undefined, "נכנסים ל "],
      ["en", "due diligence"],
      [undefined, " היום"],
    ])
  })
})
