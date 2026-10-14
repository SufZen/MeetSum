import { describe, expect, it } from "vitest"

import { normalizeForSearch, searchTranscript } from "@/lib/player/transcript-search"
import { foldText } from "@/lib/search/hebrew-normalize"

/**
 * M10 R12: the M4 in-transcript finder delegates to the M6 `foldText`, and
 * highlights still map back to raw (pointed) offsets.
 */

const samples = ["שָׁלוֹם עוֹלָם", "צה״ל ודו\"ח", "בית־ספר", "נפגשנו ב-Supabase ב-2026", "Due Diligence 1,200", "ג׳ירה"]

describe("normalizeForSearch delegates to foldText", () => {
  it("folds exactly like the M6 normalizer (curly quotes aside)", () => {
    for (const sample of samples) expect(normalizeForSearch(sample).text, sample).toBe(foldText(sample))
  })

  it("keeps one start/end offset per folded unit", () => {
    for (const sample of samples) {
      const normalized = normalizeForSearch(sample)

      expect(normalized.starts).toHaveLength(normalized.text.length)
      expect(normalized.ends).toHaveLength(normalized.text.length)
    }
  })
})

describe("finder highlights map to raw offsets", () => {
  const text = "אמרנו שֶׁהַתַּקְצִיב יאושר, ואז וְהַתַּקְצִיב שוב"

  it("finds a word with niqqud and Hebrew prefixes, highlighting the pointed letters with their marks", () => {
    const matches = searchTranscript([{ id: "s", speaker: "S", text }], "תקציב")

    expect(matches).toHaveLength(2)
    expect(matches.map((match) => text.slice(match.start, match.end))).toEqual(["תַּקְצִיב", "תַּקְצִיב"])
  })

  it("never splits a letter from a trailing point", () => {
    const pointed = "שָׁלוֹם"
    const [match] = searchTranscript([{ id: "s", speaker: "S", text: pointed }], "שלום")

    expect(pointed.slice(match.start, match.end)).toBe(pointed)
    const [first] = searchTranscript([{ id: "s", speaker: "S", text: pointed }], "ש")

    expect(pointed.slice(first.start, first.end)).toBe("שָׁ")
  })

  it("matches ⌘K-style folds: gershayim, maqaf and hyphenated prefixes", () => {
    expect(searchTranscript([{ id: "s", speaker: "S", text: "דיברנו על צה״ל" }], "צהל")).toHaveLength(1)
    expect(searchTranscript([{ id: "s", speaker: "S", text: "בית־ספר" }], "בית ספר")).toHaveLength(1)

    const hyphen = "עברנו ב-Supabase"
    const [match] = searchTranscript([{ id: "s", speaker: "S", text: hyphen }], "supabase")

    expect(hyphen.slice(match.start, match.end)).toBe("Supabase")
  })

  it("still folds curly quotes to ASCII for Latin text", () => {
    expect(searchTranscript([{ id: "s", speaker: "S", text: "the “plan” is ‘final’" }], '"plan"')).toHaveLength(1)
  })
})
