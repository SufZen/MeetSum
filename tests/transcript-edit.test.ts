import { describe, expect, it } from "vitest"

import {
  REALIGN_LCS_MAX_TOKENS,
  realignWords,
  tokenizeEditedText,
  wordKey,
} from "@/lib/meetings/transcript-edit"
import type { TranscriptWord } from "@/lib/meetings/transcript-words"

const BOUNDS = { startMs: 1000, endMs: 5000 }

/** "shalom lekulam ma nishma" style words, 1000ms..5000ms. */
function words(texts: string[], start = 1000, step = 1000, gap = 0): TranscriptWord[] {
  return texts.map((text, index) => ({
    startMs: start + index * step,
    endMs: start + (index + 1) * step - gap,
    text,
    confidence: 0.9,
  }))
}

function expectInvariants(
  result: TranscriptWord[],
  text: string,
  bounds: { startMs: number; endMs: number }
) {
  const tokens = tokenizeEditedText(text)

  expect(result.map((word) => word.text)).toEqual(tokens)
  for (const [index, word] of result.entries()) {
    expect(Number.isInteger(word.startMs) && Number.isInteger(word.endMs)).toBe(true)
    expect(word.endMs).toBeGreaterThanOrEqual(word.startMs)
    expect(word.startMs).toBeGreaterThanOrEqual(bounds.startMs)
    expect(word.endMs).toBeLessThanOrEqual(bounds.endMs)
    if (index > 0) expect(word.startMs).toBeGreaterThanOrEqual(result[index - 1].startMs)
    if (word.edited) expect(word.confidence).toBeUndefined()
  }
}

describe("wordKey", () => {
  it("ignores niqqud, case, quotes and edge punctuation", () => {
    expect(wordKey("שָׁלוֹם")).toBe(wordKey("שלום"))
    expect(wordKey("Hello,")).toBe("hello")
    expect(wordKey("«שלום»")).toBe("שלום")
    expect(wordKey("צ׳יפס")).toBe(wordKey("צ'יפס"))
    expect(wordKey("צה״ל")).toBe(wordKey('צה"ל'))
    expect(wordKey("Café")).toBe(wordKey("cafe"))
    expect(wordKey("—")).toBe("—")
  })
})

describe("realignWords", () => {
  it("keeps every timing (and confidence) when the text is unchanged", () => {
    const old = words(["שלום", "לכולם", "מה", "נשמע"])

    expect(realignWords(old, "שלום לכולם מה נשמע", BOUNDS)).toEqual(old)
  })

  it("treats a niqqud-only change as the same word but takes the new surface", () => {
    const old = words(["שלום", "לכולם"], 1000, 2000)
    const result = realignWords(old, "שָׁלוֹם לכולם", BOUNDS)

    expect(result[0]).toEqual({ startMs: 1000, endMs: 3000, text: "שָׁלוֹם", edited: true })
    expect(result[1]).toEqual(old[1])
  })

  it("keeps timings of words whose punctuation changed, marking them edited", () => {
    const old = words(["hello", "world"], 1000, 2000)
    const result = realignWords(old, "Hello, world.", BOUNDS)

    expect(result.map((word) => [word.startMs, word.endMs, word.text, word.edited])).toEqual([
      [1000, 3000, "Hello,", true],
      [3000, 5000, "world.", true],
    ])
  })

  it("replaces a word inside the span of the word it replaced", () => {
    const old = words(["we", "ship", "on", "monday"])
    const result = realignWords(old, "we ship on tuesday", BOUNDS)

    expect(result.slice(0, 3)).toEqual(old.slice(0, 3))
    expect(result[3]).toEqual({ startMs: 4000, endMs: 5000, text: "tuesday", edited: true })
    expectInvariants(result, "we ship on tuesday", BOUNDS)
  })

  it("splits a multi-word replacement by character length", () => {
    const old = words(["a", "bb", "c", "d"])
    const result = realignWords(old, "a xx yyyyyy c d", BOUNDS)

    expect(result[1]).toEqual({ startMs: 2000, endMs: 2250, text: "xx", edited: true })
    expect(result[2]).toEqual({ startMs: 2250, endMs: 3000, text: "yyyyyy", edited: true })
    expect(result[3]).toEqual(old[2])
  })

  it("inserts into the gap between anchors, or zero-duration words when there is none", () => {
    const gapped = words(["one", "two"], 1000, 2000, 1000)
    const intoGap = realignWords(gapped, "one and two", BOUNDS)

    expect(intoGap[1]).toEqual({ startMs: 2000, endMs: 3000, text: "and", edited: true })

    const contiguous = words(["one", "two"], 1000, 2000)
    const zeroWidth = realignWords(contiguous, "one and two", BOUNDS)

    expect(zeroWidth[1]).toEqual({ startMs: 3000, endMs: 3000, text: "and", edited: true })
    expectInvariants(zeroWidth, "one and two", BOUNDS)
  })

  it("appends after the last word up to the segment end", () => {
    const old = words(["one", "two"], 1000, 1000)
    const result = realignWords(old, "one two three", BOUNDS)

    expect(result[2]).toEqual({ startMs: 3000, endMs: 5000, text: "three", edited: true })
  })

  it("deletes words without moving the others", () => {
    const old = words(["um", "we", "ship", "today"])
    const result = realignWords(old, "we ship today", BOUNDS)

    expect(result).toEqual(old.slice(1))
  })

  it("re-times a full rewrite over the span of the old words", () => {
    const old = words(["a", "b", "c", "d"])
    const result = realignWords(old, "totally different", BOUNDS)

    expect(result).toEqual([
      { startMs: 1000, endMs: 2750, text: "totally", edited: true },
      { startMs: 2750, endMs: 5000, text: "different", edited: true },
    ])
  })

  it("spreads legacy segments without words proportionally, all edited", () => {
    const result = realignWords(undefined, "ab cd", { startMs: 0, endMs: 1000 })

    expect(result).toEqual([
      { startMs: 0, endMs: 500, text: "ab", edited: true },
      { startMs: 500, endMs: 1000, text: "cd", edited: true },
    ])
    expect(realignWords([], "x", { startMs: 10, endMs: 10 })).toEqual([
      { startMs: 10, endMs: 10, text: "x", edited: true },
    ])
  })

  it("keeps previously edited flags on untouched words", () => {
    const old: TranscriptWord[] = [
      { startMs: 1000, endMs: 2000, text: "fixed", edited: true },
      { startMs: 2000, endMs: 3000, text: "word", confidence: 0.8, language: "en" },
    ]
    const result = realignWords(old, "fixed word again", BOUNDS)

    expect(result.slice(0, 2)).toEqual(old)
  })

  it("returns no words for empty text", () => {
    expect(realignWords(words(["a"]), "   ", BOUNDS)).toEqual([])
  })

  it("clamps malformed old words into the bounds", () => {
    const old: TranscriptWord[] = [
      { startMs: 500, endMs: 1500, text: "early" },
      { startMs: 3000, endMs: 2500, text: "inverted" },
      { startMs: 2000, endMs: 9000, text: "late" },
    ]
    const result = realignWords(old, "early inverted late", BOUNDS)

    expectInvariants(result, "early inverted late", BOUNDS)
    expect(result[0]).toMatchObject({ startMs: 1000, endMs: 1500 })
  })

  it("skips LCS for very long middles but keeps the common prefix and suffix", () => {
    const count = REALIGN_LCS_MAX_TOKENS + 50
    const texts = Array.from({ length: count }, (_, index) => `w${index}`)
    const old = words(texts, 0, 10)
    const bounds = { startMs: 0, endMs: count * 10 }
    const rewritten = ["w0", ...texts.slice(1, -1).map((text) => `${text}x`), texts[count - 1]]
    const result = realignWords(old, rewritten.join(" "), bounds)

    expect(result[0]).toEqual(old[0])
    expect(result[count - 1]).toEqual(old[count - 1])
    expectInvariants(result, rewritten.join(" "), bounds)
  })
})

/** Deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VOCABULARY = ["שלום", "שָׁלוֹם", "מחר", "Supabase", "deploy,", "ה-API", "צה״ל", "ok", "!", "בסדר."]

describe("realignWords property test (seeded)", () => {
  it("holds every invariant and keeps untouched words for random edits", () => {
    const random = prng(20261013)
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]

    for (let round = 0; round < 400; round += 1) {
      const start = Math.floor(random() * 10_000)
      const count = Math.floor(random() * 12)
      const old: TranscriptWord[] = []
      let cursor = start

      for (let index = 0; index < count; index += 1) {
        const wordStart = cursor + Math.floor(random() * 200)
        const wordEnd = wordStart + Math.floor(random() * 600)

        old.push({ startMs: wordStart, endMs: wordEnd, text: pick(VOCABULARY), confidence: random() })
        cursor = wordEnd
      }

      const bounds = { startMs: start, endMs: cursor + Math.floor(random() * 500) }
      const tokens = old.map((word) => word.text)
      const kept = new Array<boolean>(tokens.length).fill(true)
      const edited: Array<{ text: string; origin?: number }> = tokens.map((text, origin) => ({
        text,
        origin,
      }))
      const operations = Math.floor(random() * 4)

      for (let op = 0; op < operations; op += 1) {
        const kind = random()
        const at = Math.floor(random() * (edited.length + 1))

        if (kind < 0.4 || !edited.length) {
          edited.splice(at, 0, { text: `new${round}_${op}` })
        } else if (kind < 0.7) {
          const [removed] = edited.splice(Math.min(at, edited.length - 1), 1)

          if (removed.origin !== undefined) kept[removed.origin] = false
        } else {
          const index = Math.min(at, edited.length - 1)
          const origin = edited[index].origin

          if (origin !== undefined) kept[origin] = false
          edited[index] = { text: `rep${round}_${op}` }
        }
      }

      if (!edited.length) edited.push({ text: "fallback" })

      const text = edited.map((entry) => entry.text).join(" ")
      const result = realignWords(old, text, bounds)

      expectInvariants(result, text, bounds)

      // Untouched old words that did not move relative to the other
      // survivors keep their exact timings when no token is duplicated.
      const unique = new Set(tokens.map(wordKey)).size === tokens.length
      const fresh = edited.every((entry) => entry.origin !== undefined || !tokens.includes(entry.text))

      if (unique && fresh) {
        edited.forEach((entry, index) => {
          if (entry.origin !== undefined && kept[entry.origin]) {
            expect(result[index]).toEqual(old[entry.origin])
          }
        })
      }
    }
  })

  it("is niqqud-insensitive for random Hebrew pointing", () => {
    const random = prng(7)
    const marks = ["ְ", "ִ", "ַ", "ָ", "ּ", "ׁ"]
    const base = ["שלום", "חברים", "נתחיל", "בפגישה", "היום"]

    for (let round = 0; round < 50; round += 1) {
      const old = words(base, 0, 100)
      const pointed = base.map((word) =>
        Array.from(word)
          .map((char) => (random() < 0.5 ? char + marks[Math.floor(random() * marks.length)] : char))
          .join("")
      )
      const result = realignWords(old, pointed.join(" "), { startMs: 0, endMs: 500 })

      result.forEach((word, index) => {
        expect([word.startMs, word.endMs]).toEqual([old[index].startMs, old[index].endMs])
        expect(word.text).toBe(pointed[index])
      })
    }
  })
})
