/**
 * M9 A2 (docs/parity/m9.md "Hebrew typography API"): typesetting rules,
 * idempotence, protected tokens, the bidi-visual outcome (bidi-js) and the
 * Hebrew list conjunction.
 */
import bidiFactory from "bidi-js"
import { describe, expect, it } from "vitest"

import { HEBREW_MIXED_CORPUS } from "@/tests/fixtures/hebrew-mixed"
import {
  LRI,
  NBSP,
  PDI,
  RLM,
  WJ,
  directionFor,
  fixHebrewTypography,
  hebrewList,
  isolateLtr,
  rtlLine,
  stripBidiControls,
} from "@/lib/i18n/hebrew-text"

const bidi = bidiFactory()

function visual(text: string, base: "rtl" | "ltr" = "rtl"): string {
  const levels = bidi.getEmbeddingLevels(text, base)

  return bidi.getReorderedString(text, levels)
}

describe("fixHebrewTypography", () => {
  it("adds RLM after a Latin word followed by digits", () => {
    expect(fixHebrewTypography("פגישה עם Lisboa 12 משתתפים")).toBe(`פגישה עם Lisboa${RLM} 12 משתתפים`)
  })

  it("adds a word joiner after a prefix hyphen or maqaf before Latin or digits", () => {
    expect(fixHebrewTypography("שלחו ל-Google")).toBe(`שלחו ל-${WJ}Google`)
    expect(fixHebrewTypography("נקבע ב־14:30")).toBe(`נקבע ב־${WJ}14:30`)
    expect(fixHebrewTypography("וכש-Slack")).toBe(`וכש-${WJ}Slack`)
    expect(fixHebrewTypography("קו-מנחה")).toBe("קו-מנחה")
  })

  it("puts a no-break space before a spaced dash", () => {
    expect(fixHebrewTypography("סיכום — החלטות")).toBe(`סיכום${NBSP}— החלטות`)
    expect(fixHebrewTypography("סיכום – החלטות")).toBe(`סיכום${NBSP}– החלטות`)
  })

  it("is idempotent", () => {
    for (const entry of HEBREW_MIXED_CORPUS) {
      const once = fixHebrewTypography(entry.text, { base: entry.base })

      expect(fixHebrewTypography(once, { base: entry.base }), entry.id).toBe(once)
    }
  })

  it("matches the corpus expectations", () => {
    for (const entry of HEBREW_MIXED_CORPUS) {
      expect(fixHebrewTypography(entry.text, { base: entry.base }), entry.id).toBe(entry.expectTypeset ?? entry.text)
    }
  })

  it("leaves URLs, emails, mentions and code untouched", () => {
    const text = "ראו https://example.com/a-1 2 ו-dana@example.com 3 וגם @dana-k 4 ו־`npm i 5`"
    const out = fixHebrewTypography(text)

    expect(out).toContain("https://example.com/a-1 2")
    expect(out).toContain("dana@example.com 3")
    expect(out).toContain("@dana-k 4")
    expect(out).toContain("`npm i 5`")
  })

  it("never changes English-only strings unless the base is RTL", () => {
    expect(fixHebrewTypography("Meeting with Lisboa 12 people — notes")).toBe("Meeting with Lisboa 12 people — notes")
    expect(fixHebrewTypography("Lisboa 12", { base: "rtl" })).toBe(`Lisboa${RLM} 12`)
  })
})

describe("bidi-visual (bidi-js)", () => {
  it("keeps 'Lisboa 12' in reading order once typeset", () => {
    const raw = "פגישה עם Lisboa 12 משתתפים"
    const typeset = fixHebrewTypography(raw)
    const shown = stripBidiControls(visual(typeset))

    // An RTL line is read right to left, so "12" must be drawn to the left of
    // "Lisboa". Untypeset, the digits join the Latin run and land on its right.
    const untypeset = stripBidiControls(visual(raw))

    expect(shown.indexOf("12")).toBeLessThan(shown.indexOf("Lisboa"))
    expect(untypeset.indexOf("12")).toBeGreaterThan(untypeset.indexOf("Lisboa"))
  })

  it("keeps ל-Google as one unit", () => {
    const shown = stripBidiControls(visual(fixHebrewTypography("שלחו ל-Google Docs")))

    expect(shown).toContain("Google Docs")
    expect(shown).toMatch(/Google Docs\s?-ל/)
  })
})

describe("direction and isolation helpers", () => {
  it("decides direction from a known language first", () => {
    expect(directionFor("he-IL", "Hello")).toBe("rtl")
    expect(directionFor("en", "שלום")).toBe("ltr")
    expect(directionFor("mixed", "שלום Hello")).toBe("rtl")
    expect(directionFor(null, "123 Hello")).toBe("ltr")
  })

  it("isolates and prefixes plain-text lines", () => {
    expect(isolateLtr("Slack")).toBe(`${LRI}Slack${PDI}`)
    expect(isolateLtr(isolateLtr("Slack"))).toBe(`${LRI}Slack${PDI}`)
    expect(rtlLine("Slack עדכון")).toBe(`${RLM}Slack עדכון`)
    expect(rtlLine("עדכון Slack")).toBe("עדכון Slack")
    expect(stripBidiControls(`${RLM}a${WJ}b${LRI}c${PDI}`)).toBe("abc")
  })
})

describe("hebrewList", () => {
  it("uses ו־ with a word joiner before a Latin last item", () => {
    expect(hebrewList(["Slack", "Notion", "HubSpot"], "he")).toBe(`Slack, Notion ו-${WJ}HubSpot`)
  })

  it("uses Intl.ListFormat otherwise", () => {
    expect(hebrewList(["א", "ב", "ג"], "he")).toBe("א, ב וג")
    expect(hebrewList(["a", "b", "c"], "en")).toBe("a, b, and c")
    expect(hebrewList(["a", "b"], "en", "disjunction")).toBe("a or b")
    expect(hebrewList(["רק"], "he")).toBe("רק")
    expect(hebrewList(["", "דנה"], "he")).toBe("דנה")
    expect(hebrewList([], "he")).toBe("")
  })
})
