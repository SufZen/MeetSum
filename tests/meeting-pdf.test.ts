import bidiFactory from "bidi-js"
import { describe, expect, it } from "vitest"

import { fixHebrewTypography } from "@/lib/i18n/hebrew-text"
import type { MeetingRecord, TranscriptSegment } from "@/lib/meetings/repository"
import { renderMeetingPdf, renderMeetingPdfDetailed } from "@/lib/pdf/meeting-pdf"
import { HEBREW_MIXED_CORPUS } from "@/tests/fixtures/hebrew-mixed"
import { infoValue, parsePdf, visualRtl } from "@/tests/helpers/pdf-text"

/**
 * M9 B2: the PDF is checked by parsing it (text through each font's ToUnicode
 * CMap, embedded font names, catalog and Info entries), not by snapshots.
 */

const corpusText = (id: string) => HEBREW_MIXED_CORPUS.find((entry) => entry.id === id)!.text

function segment(index: number, text: string, speaker = "דנה", language?: string): TranscriptSegment {
  return { id: `s${index}`, speaker, startMs: index * 3_600, endMs: index * 3_600 + 3_000, text, ...(language ? { language } : {}) }
}

const hebrewMeeting: MeetingRecord = {
  id: "m_8f3c2a91",
  title: "פגישת צוות שבועית",
  source: "upload",
  language: "he",
  status: "completed",
  retention: "audio",
  startedAt: "2026-10-13T06:30:00.000Z",
  durationMs: 4_800_000,
  participants: ["דנה לוי", "Lisboa Team"],
  summary: {
    overview: corpusText("latin-before-digits"),
    decisions: [corpusText("brackets"), "אבגדהוזחטיכלמנסעפצקרשת ךםןףץ"],
    actionItems: [
      { id: "a1", title: corpusText("prefix-hyphen-brand"), owner: "Dana Levi", status: "open", dueOn: "2026-10-20" },
      { id: "a2", title: "לעדכן את הלקוח", status: "done" },
    ],
  },
  transcript: [
    segment(0, corpusText("niqqud")),
    segment(1, corpusText("email-and-mention")),
    segment(2, corpusText("english-only"), "Dana", "en"),
    segment(3, corpusText("numbers-and-percent")),
  ],
}

const englishMeeting: MeetingRecord = {
  ...hebrewMeeting,
  id: "m_english",
  title: "Weekly sync",
  language: "en",
  participants: ["Alice", "Bob"],
  summary: { overview: "Team discussed the Q3 roadmap.", decisions: ["Ship v2.0"], actionItems: [] },
  transcript: [segment(0, "Let's discuss the Q3 roadmap.", "Alice"), segment(1, "Agreed.", "Bob")],
}

function visualOf(logical: string, base: "rtl" | "ltr"): string {
  const bidi = bidiFactory()
  const text = fixHebrewTypography(logical)
  const visual = bidi.getReorderedString(text, bidi.getEmbeddingLevels(text, base))

  return visual.replace(/[‎‏⁦-⁩⁠]/g, "").replace(/ /g, " ")
}

describe("renderMeetingPdf (Hebrew)", () => {
  it("writes a PDF 1.7 with /Lang, a UTF-16BE title and subsetted Plex fonts", async () => {
    const pdf = parsePdf(await renderMeetingPdf(hebrewMeeting, { locale: "he", timeZone: "Asia/Jerusalem" }))
    const catalog = [...pdf.objects.values()].find((object) => /\/Type \/Catalog/.test(object.dict))!
    const title = infoValue(pdf, "Title")!

    expect(pdf.header).toBe("%PDF-1.7")
    expect(catalog.dict).toContain("/Lang (he-IL)")
    expect(catalog.dict).toMatch(/\/MarkInfo/)
    expect(title.text).toBe("פגישת צוות שבועית")
    expect(title.raw.startsWith("<feff") || title.raw.startsWith("<FEFF") || title.raw.includes("þÿ")).toBe(true)
    expect(pdf.baseFonts.some((name) => /^[A-Z]{6}\+IBMPlexSansHebrew/.test(name))).toBe(true)
    expect(pdf.baseFonts.some((name) => /^[A-Z]{6}\+IBMPlexMono/.test(name))).toBe(true)
    expect(pdf.baseFonts.some((name) => /Helvetica/.test(name))).toBe(false)
    expect([...pdf.objects.values()].some((object) => /\/Subtype \/Type1/.test(object.dict))).toBe(false)
  })

  it("maps U+05D0–U+05EA through the ToUnicode CMap (copyable Hebrew)", async () => {
    const pdf = parsePdf(await renderMeetingPdf(hebrewMeeting, { locale: "he", timeZone: "Asia/Jerusalem" }))
    const hebrewFont = pdf.baseFonts.find((name) => /\+IBMPlexSansHebrew$/.test(name))!
    const mapped = new Set([...pdf.toUnicode.get(hebrewFont)!.values()].join(""))

    for (let cp = 0x05d0; cp <= 0x05ea; cp++) {
      const letter = String.fromCodePoint(cp)

      expect(mapped.has(letter)).toBe(true)
    }
  })

  it("draws headings, meta and page numbers in Hebrew, lines in visual RTL order", async () => {
    const pdf = parsePdf(await renderMeetingPdf(hebrewMeeting, { locale: "he", timeZone: "Asia/Jerusalem" }))
    const text = pdf.pages.flatMap((page) => page.lines)

    expect(text).toContain(visualRtl("פגישת צוות שבועית"))
    for (const heading of ["סקירה", "משימות", "החלטות", "תמליל"]) {
      expect(text).toContain(visualRtl(heading))
    }
    expect(text.some((line) => line.includes(visualRtl("עמוד")) && line.includes("1"))).toBe(true)
    // "שעה ו־20 דקות" in visual order (the digits keep their LTR order).
    expect(text.join("\n")).toContain("תוקד 20־ו העש")
  })

  it("renders the mixed corpus with correct bidi: digits after Latin, mirrored brackets, intact emails", async () => {
    const pdf = parsePdf(await renderMeetingPdf(hebrewMeeting, { locale: "he", timeZone: "Asia/Jerusalem" }))
    const all = pdf.pages.flatMap((page) => page.runs.map((run) => run.text)).join("|")
    const lines = pdf.pages.flatMap((page) => page.lines).join("\n")

    expect(lines.replace(/ /g, "")).toContain(visualOf(corpusText("latin-before-digits"), "rtl").replace(/ /g, ""))
    expect(lines.replace(/ /g, "")).toContain("[יפוס]רשוא(Q4)ביצקתה")
    expect(all).toContain("dana.levi@example.com")
    expect(lines.replace(/ /g, "")).toContain("12.5%")
  })

  it("keeps niqqud on its letter (marks follow their base glyph)", async () => {
    const pdf = parsePdf(await renderMeetingPdf(hebrewMeeting, { locale: "he", timeZone: "Asia/Jerusalem" }))
    const text = pdf.pages.flatMap((page) => page.runs.map((run) => run.text)).join("")
    const clusters = [...new Intl.Segmenter("he", { granularity: "grapheme" }).segment("שָׁלוֹם")].map((s) => s.segment)

    expect(text).toContain([...clusters].reverse().join(""))
  })

  it("puts the mono timecode at the reading start (right) of RTL transcript rows", async () => {
    const pdf = parsePdf(await renderMeetingPdf(hebrewMeeting, { locale: "he", timeZone: "Asia/Jerusalem" }))
    const runs = pdf.pages.flatMap((page) => page.runs)
    const timecode = runs.find((run) => run.text === "0:03" && /IBMPlexMono/.test(run.font))!
    const speakerRow = runs.filter((run) => Math.abs(run.y - timecode.y) < 3 && run !== timecode)

    expect(timecode).toBeDefined()
    expect(speakerRow.length).toBeGreaterThan(0)
    expect(speakerRow.every((run) => run.x < timecode.x)).toBe(true)
  })

  it("lays out English segments LTR inside a Hebrew meeting", async () => {
    const pdf = parsePdf(await renderMeetingPdf(hebrewMeeting, { locale: "he", timeZone: "Asia/Jerusalem" }))
    const lines = pdf.pages.flatMap((page) => page.lines).join("\n")

    expect(lines).toContain("Weekly sync with Lisboa 12 people")
  })
})

describe("renderMeetingPdf (English)", () => {
  it("uses English chrome and embeds no Hebrew font", async () => {
    const pdf = parsePdf(await renderMeetingPdf(englishMeeting, { locale: "en", timeZone: "UTC" }))
    const lines = pdf.pages.flatMap((page) => page.lines)

    expect(pdf.header).toBe("%PDF-1.7")
    expect([...pdf.objects.values()].some((object) => object.dict.includes("/Lang (en-US)"))).toBe(true)
    expect(pdf.baseFonts.some((name) => /IBMPlexSansHebrew/.test(name))).toBe(false)
    expect(pdf.baseFonts.some((name) => /\+IBMPlexSans/.test(name))).toBe(true)
    expect(lines).toContain("Weekly sync")
    expect(lines).toContain("Overview")
    expect(lines).toContain("Page 1 of 1")
    expect(lines.join("\n")).toContain("Alice: Let's discuss the Q3 roadmap.")
  })
})

describe("renderMeetingPdf meta line", () => {
  it("translates the source and writes the English date with commas", async () => {
    const en = parsePdf(
      await renderMeetingPdf({ ...englishMeeting, startedAt: "2026-10-12T12:13:00Z" }, { locale: "en", timeZone: "Asia/Jerusalem" })
    )
    const enLines = en.pages.flatMap((page) => page.lines).join(" | ")

    expect(enLines).toContain("Date: Oct 12, 2026, 3:13 PM")
    expect(enLines).toContain("Source: Upload")
    expect(enLines).not.toContain("Source: upload")

    const he = parsePdf(await renderMeetingPdf(hebrewMeeting, { locale: "he", timeZone: "Asia/Jerusalem" }))
    const heLines = he.pages.flatMap((page) => page.lines).join(" | ")

    expect(heLines).toContain(visualRtl("העלאה"))
    expect(heLines).not.toContain("upload")
  })
})

describe("renderMeetingPdf limits", () => {
  it("renders a 2-hour, 2000-segment Hebrew meeting in under 3 s with page numbers", async () => {
    const texts = HEBREW_MIXED_CORPUS.map((entry) => entry.text)
    const transcript = Array.from({ length: 2000 }, (_, index) => segment(index, texts[index % texts.length]!, index % 2 ? "דנה" : "Yossi"))
    const started = performance.now()
    const result = await renderMeetingPdfDetailed({ ...hebrewMeeting, transcript }, { locale: "he", timeZone: "Asia/Jerusalem" })
    const elapsed = performance.now() - started
    const pdf = parsePdf(result.buffer)
    const lastPage = pdf.pages[pdf.pages.length - 1]!

    expect(elapsed).toBeLessThan(3000)
    expect(result.pages).toBeGreaterThan(20)
    expect(lastPage.lines.join("\n")).toContain(visualRtl(`עמוד ${result.pages} מתוך ${result.pages}`).replace(/\d+/g, (n) => visualRtl(n)))
  }, 20_000)

  it("truncates the transcript at MEETSUM_PDF_MAX_SEGMENTS with a localized note", async () => {
    const transcript = Array.from({ length: 30 }, (_, index) => segment(index, "שורה בתמליל"))
    const result = await renderMeetingPdfDetailed(
      { ...hebrewMeeting, transcript },
      { locale: "he", timeZone: "Asia/Jerusalem", env: { MEETSUM_PDF_MAX_SEGMENTS: "10" } as unknown as NodeJS.ProcessEnv }
    )
    const lines = parsePdf(result.buffer).pages.flatMap((page) => page.lines).join("\n")

    expect(result.truncated).toBe(true)
    expect(lines).toContain(visualRtl("התמליל קוצר"))
  })

  it("replaces glyphs outside Plex with U+25A1 and counts them", async () => {
    const result = await renderMeetingPdfDetailed(
      { ...hebrewMeeting, transcript: [segment(0, "שלום 🎉 مرحبا")] },
      { locale: "he", timeZone: "Asia/Jerusalem" }
    )
    const text = parsePdf(result.buffer).pages.flatMap((page) => page.runs.map((run) => run.text)).join("")

    expect(result.missingGlyphs).toBe(6) // the emoji and the five Arabic letters
    expect(text).toContain("□")
    expect(text).not.toContain("🎉")
  })
})
