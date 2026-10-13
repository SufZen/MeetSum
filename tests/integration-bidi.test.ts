import { describe, expect, it } from "vitest"

import {
  LRI,
  LRM,
  PDI,
  RLM,
  chunkText,
  firstStrongDirection,
  isRtlLanguage,
  isolateLtr,
  rtlLine,
} from "@/lib/integrations/bidi"

/** M8 Step 0: bidi helpers and the shared chunker (docs/parity/m8.md). */

/** True when `chunks` are `text` with only whitespace removed at the joins. */
function reassembles(text: string, chunks: string[]): boolean {
  let cursor = 0

  for (const chunk of chunks) {
    while (cursor < text.length && !text.startsWith(chunk, cursor) && /\s/.test(text[cursor] as string)) cursor += 1
    if (!text.startsWith(chunk, cursor)) return false
    cursor += chunk.length
  }

  return /^\s*$/.test(text.slice(cursor))
}

function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
}

describe("direction helpers", () => {
  it("knows the RTL languages", () => {
    for (const lang of ["he", "he-IL", "ar", "ar_EG", "fa", "ur", "yi", " HE "]) expect(isRtlLanguage(lang), lang).toBe(true)
    for (const lang of ["en", "pt", "mixed", "", undefined, null]) expect(isRtlLanguage(lang), String(lang)).toBe(false)
  })

  it("finds the first strong direction, skipping neutrals and isolates", () => {
    expect(firstStrongDirection("שלום world")).toBe("rtl")
    expect(firstStrongDirection("12:30 — Hello")).toBe("ltr")
    expect(firstStrongDirection("12:30 — שלום")).toBe("rtl")
    expect(firstStrongDirection(`${LRI}Dana${PDI} אמרה`)).toBe("rtl")
    expect(firstStrongDirection(`${RLM}Q3 budget`)).toBe("rtl")
    expect(firstStrongDirection("12:30 🚀 !")).toBe("neutral")
  })

  it("prefixes RLM only where a line does not start with RTL text", () => {
    expect(rtlLine("שלום")).toBe("שלום")
    expect(rtlLine("Q3 תקציב")).toBe(`${RLM}Q3 תקציב`)
    expect(rtlLine("• משימה")).toBe(`${RLM}• משימה`)
    expect(rtlLine(`${RLM}כבר`)).toBe(`${RLM}כבר`)
    expect(rtlLine("")).toBe("")
    expect(rtlLine("שורה\nhttps://x.example/a\n")).toBe(`שורה\n${RLM}https://x.example/a\n`)
    // Never inside a URL.
    expect(rtlLine("https://x.example/a").indexOf(RLM)).toBe(0)
  })

  it("isolates LTR tokens with marks or isolates", () => {
    expect(isolateLtr("00:12", "marks")).toBe(`${LRM}00:12${LRM}`)
    expect(isolateLtr("dana@example.com", "isolates")).toBe(`${LRI}dana@example.com${PDI}`)
    expect(isolateLtr("", "marks")).toBe("")
  })
})

describe("chunkText", () => {
  it("returns short text as is and nothing for empty text", () => {
    expect(chunkText("short", 2000)).toEqual(["short"])
    expect(chunkText("", 10)).toEqual([])
    expect(() => chunkText("x", 0)).toThrow(RangeError)
  })

  it("prefers paragraph, then sentence, then word boundaries", () => {
    const paragraphs = "First paragraph here.\n\nSecond paragraph is here."

    expect(chunkText(paragraphs, 30)).toEqual(["First paragraph here.", "Second paragraph is here."])
    expect(chunkText("One sentence. Two sentence. Three sentence.", 30)).toEqual([
      "One sentence. Two sentence.",
      "Three sentence.",
    ])
    expect(chunkText("alpha beta gamma delta epsilon", 12)).toEqual(["alpha beta", "gamma delta", "epsilon"])
  })

  it("keeps every chunk within max and reassembles the Hebrew text", () => {
    const text = Array.from({ length: 300 }, (_, index) => `משפט מספר ${index} על התקציב של Q3, עם dana@example.com.`).join(" ")
    const chunks = chunkText(text, 2000)

    expect(chunks.length).toBeGreaterThan(5)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000)
    expect(reassembles(text, chunks)).toBe(true)
  })

  it("never splits a surrogate pair or grapheme cluster", () => {
    const family = "👨‍👩‍👧‍👦"
    const text = `${family}${"😀".repeat(30)}${family}א֫ב֫ג֫`
    const chunks = chunkText(text, 15)

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(15)
      expect(hasLoneSurrogate(chunk)).toBe(false)
    }
    expect(chunks).toContain(family)
    expect(chunks.join("")).toBe(text)
  })

  it("falls back to code points for a grapheme longer than max, and throws below one code point", () => {
    const family = "👨‍👩‍👧‍👦"
    const chunks = chunkText(family, 4)

    for (const chunk of chunks) expect(hasLoneSurrogate(chunk)).toBe(false)
    expect(chunks.join("")).toBe(family)
    expect(() => chunkText("😀😀", 1)).toThrow(RangeError)
  })

  it("splits an unbroken run by graphemes", () => {
    const text = "a".repeat(25)

    expect(chunkText(text, 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)])
  })
})
