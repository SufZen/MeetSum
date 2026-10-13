import bidiFactory from "bidi-js"
import { describe, expect, it } from "vitest"

import { fixHebrewTypography } from "@/lib/i18n/hebrew-text"
import {
  layoutParagraph,
  MISSING_GLYPH,
  visualLines,
  type MeasureText,
  type PdfFontRef,
  type SupportsCodePoint,
} from "@/lib/pdf/bidi-layout"
import { HEBREW_MIXED_CORPUS } from "@/tests/fixtures/hebrew-mixed"

/** 5pt per visible code point at size 10; combining marks are zero width. */
const measure: MeasureText = (text, _font, size) => [...text].filter((char) => !/\p{M}/u.test(char)).length * size * 0.5

const supports: SupportsCodePoint = (cp, font: PdfFontRef) => {
  if (cp > 0xffff) return false // no emoji in Plex
  if (cp >= 0x0590 && cp <= 0x05ff) return font.family === "hebrew"
  return cp < 0x2100
}

const corpus = (id: string) => {
  const entry = HEBREW_MIXED_CORPUS.find((candidate) => candidate.id === id)

  if (!entry) throw new Error(`missing corpus entry ${id}`)

  return entry
}

function visual(text: string, base: "rtl" | "ltr", width = 10_000): string[] {
  return visualLines(layoutParagraph(text, { base, width, size: 10, measure, supports }))
}

describe("layoutParagraph: visual order (bidi-js + grapheme clusters)", () => {
  it("keeps '12' after 'Lisboa' once the RLM is typeset (and not without it)", () => {
    const entry = corpus("latin-before-digits")

    expect(visual(fixHebrewTypography(entry.text), entry.base)).toEqual(["םיפתתשמ 12 Lisboa םע השיגפ"])
    expect(visual(entry.text, entry.base)).toEqual(["םיפתתשמ Lisboa 12 םע השיגפ"])
  })

  it("never splits a niqqud cluster from its letter", () => {
    const entry = corpus("niqqud")
    const [line] = visual(entry.text, entry.base)
    const naive = bidiFactory().getReorderedString(entry.text, bidiFactory().getEmbeddingLevels(entry.text, "rtl"))
    const clusters = [...new Intl.Segmenter("he", { granularity: "grapheme" }).segment(entry.text)].map((s) => s.segment)

    // Visual = the logical clusters in reverse order, each cluster intact.
    expect(line).toBe([...clusters].reverse().join(""))
    // The naive code-unit reversal puts marks before their base letter.
    expect(naive).not.toBe(line)
    expect(line!.startsWith("ה")).toBe(true)
    expect(/^\p{M}/u.test(line!)).toBe(false)
  })

  it("mirrors brackets in RTL runs", () => {
    const entry = corpus("brackets")

    expect(visual(entry.text, entry.base)).toEqual(["[יפוס] רשוא (Q4) ביצקתה"])
  })

  it("leaves an English paragraph untouched", () => {
    const entry = corpus("english-only")

    expect(visual(entry.text, entry.base)).toEqual([entry.text])
  })

  it("keeps emails, URLs, Latin words, percentages and gershayim contiguous", () => {
    const [email] = visual(fixHebrewTypography(corpus("email-and-mention").text), "rtl")
    const [url] = visual(corpus("url-untouched").text, "rtl")
    const [codeSwitch] = visual(fixHebrewTypography(corpus("code-switch").text), corpus("code-switch").base)
    const [numbers] = visual(fixHebrewTypography(corpus("numbers-and-percent").text), "rtl")
    const [gershayim] = visual(corpus("gershayim").text, "rtl")

    expect(email).toContain("dana.levi@example.com")
    expect(url).toContain("https://meetsum.example/he?meeting=m_1&t=90")
    expect(codeSwitch).toContain("deal")
    expect(codeSwitch).toContain("Friday")
    expect(numbers).toContain("12.5%")
    expect(numbers).toContain("2025")
    expect(gershayim).toContain("ל״הצ")
  })

  it("never draws bidi controls or word joiners", () => {
    for (const entry of HEBREW_MIXED_CORPUS) {
      for (const line of visual(fixHebrewTypography(entry.text), entry.base)) {
        expect(line).not.toMatch(/[‎‏‪-‮⁦-⁩⁠ ]/)
      }
    }
  })
})

describe("layoutParagraph: line breaking", () => {
  it("does not break after a prefix hyphen followed by a word joiner", () => {
    const typeset = fixHebrewTypography(corpus("prefix-hyphen-brand").text)
    const lines = visual(typeset, "rtl", 100)

    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain("Google")
    expect(lines[1]).toContain("ל")
    // Without the WJ the line may break right after "ל-".
    const raw = visual(corpus("prefix-hyphen-brand").text, "rtl", 100)
    expect(raw[0]).toContain("ל")
    expect(raw[1]).not.toContain("ל")
  })

  it("wraps within the box and right-aligns RTL lines", () => {
    const text = "פגישת צוות שבועית על התקציב הרבעוני ועל תוכנית העבודה לשנה הבאה עם Lisboa ועם כל הצוות"
    const layout = layoutParagraph(text, { base: "rtl", width: 120, size: 10, measure, supports })

    expect(layout.lines.length).toBeGreaterThan(3)
    for (const line of layout.lines) {
      expect(line.width).toBeLessThanOrEqual(120)
      expect(line.x + line.width).toBeCloseTo(120)
      expect(line.runs.map((run) => run.text).join("")).not.toMatch(/^ | $/)
    }
    const ltr = layoutParagraph("Weekly sync with the whole team about the budget", { base: "ltr", width: 120, size: 10, measure })
    for (const line of ltr.lines) expect(line.x).toBe(0)
  })

  it("breaks a word wider than the box by grapheme cluster", () => {
    const lines = visual("א".repeat(30), "rtl", 50)

    expect(lines).toHaveLength(3)
    expect(lines.every((line) => [...line].length === 10)).toBe(true)
  })
})

describe("layoutParagraph: fonts", () => {
  it("assigns Hebrew, Latin and mono runs with increasing x offsets", () => {
    const layout = layoutParagraph(`⁦${"12:34"}⁩ פתיחה עם Dana`, { base: "rtl", width: 1000, size: 10, measure, supports })
    const runs = layout.lines[0]!.runs

    expect(runs.find((run) => run.text === "12:34")?.font.family).toBe("mono")
    expect(runs.find((run) => run.text.includes("Dana"))?.font.family).toBe("sans")
    expect(runs.find((run) => run.text.includes("החיתפ"))?.font.family).toBe("hebrew")
    runs.reduce((x, run) => {
      expect(run.x).toBeCloseTo(x)
      return x + run.width
    }, 0)
  })

  it("keeps bold spans bold", () => {
    const layout = layoutParagraph([{ text: "דנה: ", bold: true }, { text: "שלום לכולם" }], {
      base: "rtl",
      width: 1000,
      size: 10,
      measure,
      supports,
    })
    const bold = layout.lines[0]!.runs.filter((run) => run.font.weight === "bold").map((run) => run.text).join("")

    expect(bold).toContain("הנד")
  })

  it("replaces glyphs no font has with U+25A1 and counts them", () => {
    const layout = layoutParagraph("שלום 🎉 world", { base: "rtl", width: 1000, size: 10, measure, supports })

    expect(layout.missingGlyphs).toBe(1)
    expect(visualLines(layout)[0]).toContain(MISSING_GLYPH)
  })
})
