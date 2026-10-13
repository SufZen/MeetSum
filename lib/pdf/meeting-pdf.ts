import PDFDocument from "pdfkit"

import { formatDate, formatDuration, formatTimecode, type Fmt } from "@/lib/i18n/format"
import { directionFor, fixHebrewTypography, hasHebrew, hebrewList, isolateLtr } from "@/lib/i18n/hebrew-text"
import { m9ExportsMessages } from "@/lib/i18n/m9/exports"
import { resolveTimeZone } from "@/lib/i18n/time-zone"
import { formatMessage } from "@/lib/i18n/workspace-messages"
import type { MeetingRecord } from "@/lib/meetings/repository"
import {
  layoutParagraph,
  MISSING_GLYPH,
  type BidiSpan,
  type LayoutLine,
  type PdfFontFamily,
  type PdfFontRef,
  type PdfFontWeight,
} from "@/lib/pdf/bidi-layout"
import { loadPdfFace, measurePdfText, pdfFontKey, type PdfFace } from "@/lib/pdf/fonts"

/**
 * Hebrew-capable meeting PDF (M9 B2, docs/parity/m9.md "PDF").
 *
 * pdfkit (A4, PDF 1.7, tagged, `/Lang`, UTF-16 Info) with subsetted IBM Plex
 * Sans Hebrew / Sans / Mono (ToUnicode CMaps, so Hebrew stays copyable).
 * Every paragraph goes through `layoutParagraph` (logical wrap, visual bidi
 * reorder by grapheme cluster, mirroring). Headings, labels and page chrome
 * follow the viewer's locale; content keeps the meeting / segment language.
 * Typography (`fixHebrewTypography`) is applied here, never persisted.
 */

export type ExportLocale = "he" | "en"

export type MeetingPdfOptions = {
  /** Chrome language (headings, labels, page numbers). Defaults to the meeting's. */
  locale?: ExportLocale
  /** IANA zone for dates; defaults to the env / Asia/Jerusalem chain. */
  timeZone?: string
  env?: NodeJS.ProcessEnv
  /** Overrides `MEETSUM_PDF_MAX_SEGMENTS` (default 5000). */
  maxSegments?: number
}

export type MeetingPdfResult = { buffer: Buffer; pages: number; missingGlyphs: number; truncated: boolean }

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN_X = 56
const CONTENT_TOP = 72
const CONTENT_BOTTOM = PAGE_HEIGHT - 64
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2
const TIMECODE_COLUMN = 46
const COLUMN_GAP = 10
const DEFAULT_MAX_SEGMENTS = 5000

/** Print colours (PDF content, not UI tokens). */
const INK = [32, 35, 40] as const
const MUTED = [107, 114, 128] as const
const RULE = [209, 213, 219] as const

type Rgb = readonly [number, number, number]

type Messages = (typeof m9ExportsMessages)["en"]

type BlockStyle = {
  base: "rtl" | "ltr"
  size: number
  color?: Rgb
  lineHeight?: number
  /** Indent from the reading-start side. */
  indent?: number
  bold?: boolean
  align?: "start" | "center"
}

function isExportLocale(value: unknown): value is ExportLocale {
  return value === "he" || value === "en"
}

function maxSegmentsFrom(options: MeetingPdfOptions, env: NodeJS.ProcessEnv): number {
  if (options.maxSegments && options.maxSegments > 0) return Math.floor(options.maxSegments)

  const parsed = Number.parseInt(env.MEETSUM_PDF_MAX_SEGMENTS ?? "", 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SEGMENTS
}

function meetingDurationMs(meeting: MeetingRecord): number {
  if (meeting.durationMs && meeting.durationMs > 0) return meeting.durationMs

  return (meeting.transcript ?? []).reduce((max, segment) => Math.max(max, segment.endMs ?? 0), 0)
}

function participantNames(meeting: MeetingRecord): string[] {
  return meeting.participantDetails?.length
    ? meeting.participantDetails.map((participant) => participant.name)
    : meeting.participants
}

/** A name, date or token that isn't Hebrew is isolated LTR inside the line. */
function isolateIfLatin(value: string): string {
  return hasHebrew(value) ? value : isolateLtr(value)
}

/** `YYYY-MM-DD` → localized date at UTC midnight (a calendar date has no zone). */
function formatDueDate(value: string, locale: ExportLocale): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)

  if (!match) return value

  return formatDate(`${match[1]}T00:00:00.000Z`, { locale, timeZone: "UTC" }, "date") || value
}

class PdfWriter {
  readonly doc: PDFKit.PDFDocument
  private readonly faces = new Map<string, PdfFace>()
  private readonly widths = new Map<string, number>()
  private readonly used = new Set<string>()
  y = CONTENT_TOP
  missingGlyphs = 0

  constructor(
    doc: PDFKit.PDFDocument,
    private readonly env: NodeJS.ProcessEnv
  ) {
    this.doc = doc
  }

  face(font: PdfFontRef): PdfFace {
    const key = pdfFontKey(font)
    let face = this.faces.get(key)

    if (!face) {
      face = loadPdfFace(font, this.env)
      this.faces.set(key, face)
    }

    return face
  }

  readonly measure = (text: string, font: PdfFontRef, size: number): number => {
    const key = `${pdfFontKey(font)}|${size}|${text}`
    let width = this.widths.get(key)

    if (width === undefined) {
      width = measurePdfText(this.face(font), text, size)
      this.widths.set(key, width)
    }

    return width
  }

  readonly supports = (codePoint: number, font: PdfFontRef): boolean => this.face(font).hasGlyphForCodePoint(codePoint)

  layout(spans: string | BidiSpan[], style: BlockStyle, width: number): LayoutLine[] {
    const result = layoutParagraph(
      typeof spans === "string" ? [{ text: spans, bold: style.bold }] : spans.map((span) => ({ ...span, bold: span.bold ?? style.bold })),
      { base: style.base, width, size: style.size, measure: this.measure, supports: this.supports, align: style.align }
    )

    this.missingGlyphs += result.missingGlyphs

    return result.lines
  }

  addPage() {
    this.doc.addPage({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: 0 })
    this.y = CONTENT_TOP
  }

  ensure(height: number) {
    if (this.y + height > CONTENT_BOTTOM) this.addPage()
  }

  drawLine(line: LayoutLine, left: number, top: number, size: number, color: Rgb = INK) {
    for (const run of line.runs) {
      if (!run.text.trim()) continue

      const key = pdfFontKey(run.font)

      if (!this.used.has(key)) {
        this.doc.registerFont(key, this.face(run.font) as unknown as Buffer)
        this.doc.font(key)
        // Plex has no U+25A1: a missing glyph draws as .notdef (a box), and
        // the ToUnicode entry of glyph 0 copies as U+25A1 instead of U+0000.
        const embedded = (this.doc as unknown as { _font?: { unicode?: number[][] } })._font

        if (embedded?.unicode) embedded.unicode[0] = [MISSING_GLYPH.codePointAt(0)!]
        this.used.add(key)
      }

      this.doc
        .font(key)
        .fontSize(size)
        .fillColor([...color])
        .text(run.text, left + line.x + run.x, top, { lineBreak: false })
    }
  }

  /** Flows a paragraph inside the content box, breaking pages between lines. */
  paragraph(spans: string | BidiSpan[], style: BlockStyle, after = 0) {
    const indent = style.indent ?? 0
    const width = CONTENT_WIDTH - indent
    const left = style.base === "rtl" ? MARGIN_X : MARGIN_X + indent
    const lineHeight = style.lineHeight ?? style.size * 1.5

    for (const line of this.layout(spans, style, width)) {
      this.ensure(lineHeight)
      this.drawLine(line, left, this.y, style.size, style.color)
      this.y += lineHeight
    }

    this.y += after
  }

  rule() {
    this.ensure(12)
    this.doc
      .moveTo(MARGIN_X, this.y + 4)
      .lineTo(PAGE_WIDTH - MARGIN_X, this.y + 4)
      .lineWidth(0.5)
      .strokeColor([...RULE])
      .stroke()
    this.y += 12
  }
}

function sectionHeading(writer: PdfWriter, text: string, base: "rtl" | "ltr") {
  writer.ensure(48)
  writer.y += 10
  writer.paragraph(text, { base, size: 13, bold: true, lineHeight: 20 }, 4)
}

function bulletSpans(text: string, bold = false, marker = "•"): BidiSpan[] {
  return [{ text: `${marker} ` }, { text: fixHebrewTypography(text), bold }]
}

/** Renders the PDF and reports page and missing-glyph counts. */
export async function renderMeetingPdfDetailed(
  meeting: MeetingRecord,
  options: MeetingPdfOptions = {}
): Promise<MeetingPdfResult> {
  const env = options.env ?? process.env
  const meetingBase = directionFor(meeting.language, meeting.title)
  const locale: ExportLocale = isExportLocale(options.locale) ? options.locale : meetingBase === "rtl" ? "he" : "en"
  const chromeBase: "rtl" | "ltr" = locale === "he" ? "rtl" : "ltr"
  const fmt: Fmt = { locale, timeZone: options.timeZone ?? resolveTimeZone({ env: env.MEETSUM_DEFAULT_TIMEZONE }) }
  const t: Messages = m9ExportsMessages[locale]
  const title = fixHebrewTypography(meeting.title.trim() || "MeetSum")
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    pdfVersion: "1.7",
    tagged: true,
    lang: locale === "he" ? "he-IL" : "en-US",
    displayTitle: true,
    compress: true,
    font: null as unknown as string,
    info: {
      Title: meeting.title,
      Author: "MeetSum",
      Subject: t.pdfSubject,
      Creator: "MeetSum",
      Producer: "MeetSum",
    },
  })
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)
  })
  const writer = new PdfWriter(doc, env)

  writer.addPage()

  // Title and meta.
  writer.paragraph(title, { base: directionFor(meeting.language, meeting.title), size: 20, bold: true, lineHeight: 28 }, 6)

  const durationMs = meetingDurationMs(meeting)
  const meta: string[] = [
    `${t.pdfDate}: ${isolateIfLatin(formatDate(meeting.startedAt, fmt, "dateTime"))}`,
    ...(durationMs > 0 ? [`${t.pdfDuration}: ${formatDuration(durationMs, fmt, "long")}`] : []),
    `${t.pdfSource}: ${isolateLtr(meeting.source)}`,
  ]

  writer.paragraph(meta.join("  ·  "), { base: chromeBase, size: 9.5, color: MUTED }, 2)

  const names = participantNames(meeting).filter(Boolean)

  if (names.length) {
    writer.paragraph(
      `${t.pdfParticipants}: ${hebrewList(names.map(isolateIfLatin), locale)}`,
      { base: chromeBase, size: 9.5, color: MUTED },
      2
    )
  }

  writer.rule()

  // Sections in M5 order.
  const overview = meeting.intelligence?.overview?.trim() || meeting.summary?.overview?.trim() || ""

  if (overview) {
    sectionHeading(writer, t.pdfOverview, chromeBase)
    for (const block of overview.split(/\n{2,}/)) {
      writer.paragraph(fixHebrewTypography(block.trim()), { base: directionFor(meeting.language, block), size: 10.5 }, 6)
    }
  }

  const actionItems = meeting.summary?.actionItems ?? []

  if (actionItems.length) {
    sectionHeading(writer, t.pdfActionItems, chromeBase)
    for (const item of actionItems) {
      const isDone = item.status === "done"
      const details: string[] = []

      if (item.owner) details.push(`${t.pdfOwner}: ${isolateIfLatin(item.owner)}`)
      if (item.dueOn || item.dueDate) {
        details.push(formatMessage(t.pdfDue, { date: isolateIfLatin(formatDueDate(item.dueOn ?? item.dueDate ?? "", locale)) }))
      }
      if (isDone) details.push(t.pdfDone)

      writer.paragraph(
        [
          ...bulletSpans(item.title, !isDone, isDone ? "✓" : "•"),
          ...(details.length ? [{ text: `  — ${details.join(" · ")}` }] : []),
        ],
        { base: directionFor(meeting.language, item.title), size: 10.5, indent: 8 },
        3
      )
    }
  }

  const decisions = meeting.summary?.decisions?.length ? meeting.summary.decisions : (meeting.intelligence?.decisions ?? [])

  if (decisions.length) {
    sectionHeading(writer, t.pdfDecisions, chromeBase)
    for (const decision of decisions) {
      writer.paragraph(bulletSpans(decision), { base: directionFor(meeting.language, decision), size: 10.5, indent: 8 }, 3)
    }
  }

  const openQuestions = meeting.intelligence?.openQuestions ?? []

  if (openQuestions.length) {
    sectionHeading(writer, t.pdfOpenQuestions, chromeBase)
    for (const question of openQuestions) {
      writer.paragraph(bulletSpans(question), { base: directionFor(meeting.language, question), size: 10.5, indent: 8 }, 3)
    }
  }

  const chapters = meeting.intelligence?.chapters ?? []

  if (chapters.length) {
    sectionHeading(writer, t.pdfChapters, chromeBase)
    for (const chapter of chapters) {
      writer.paragraph(
        [{ text: `${isolateLtr(formatTimecode(chapter.startMs))}  ` }, { text: fixHebrewTypography(chapter.title), bold: true }],
        { base: directionFor(meeting.language, chapter.title), size: 10.5 },
        2
      )
      if (chapter.summary?.trim()) {
        writer.paragraph(fixHebrewTypography(chapter.summary.trim()), {
          base: directionFor(meeting.language, chapter.summary),
          size: 9.5,
          color: MUTED,
          indent: 34,
        }, 4)
      }
    }
  }

  // Transcript: mono LTR timecode on the reading-start side, speaker in bold.
  const transcript = meeting.transcript ?? []
  const limit = maxSegmentsFrom(options, env)
  const truncated = transcript.length > limit

  if (transcript.length) {
    sectionHeading(writer, t.pdfTranscript, chromeBase)

    const textWidth = CONTENT_WIDTH - TIMECODE_COLUMN - COLUMN_GAP
    const size = 9.5
    const lineHeight = 14
    const timecodeFont: PdfFontRef = { family: "mono" as PdfFontFamily, weight: "regular" as PdfFontWeight }

    for (const segment of transcript.slice(0, limit)) {
      const base = directionFor(segment.language ?? meeting.language, segment.text)
      const lines = writer.layout(
        [{ text: `${segment.speaker}: `, bold: true }, { text: fixHebrewTypography(segment.text) }],
        { base, size },
        textWidth
      )
      const timecode = formatTimecode(segment.startMs)
      const timecodeWidth = writer.measure(timecode, timecodeFont, 8.5)
      const textLeft = meetingBase === "rtl" ? MARGIN_X : MARGIN_X + TIMECODE_COLUMN + COLUMN_GAP
      const timecodeLeft =
        meetingBase === "rtl" ? PAGE_WIDTH - MARGIN_X - timecodeWidth : MARGIN_X

      lines.forEach((line, index) => {
        writer.ensure(lineHeight)
        if (index === 0) {
          writer.drawLine(
            { runs: [{ text: timecode, font: timecodeFont, x: 0, width: timecodeWidth }], width: timecodeWidth, x: 0 },
            timecodeLeft,
            writer.y + 1,
            8.5,
            MUTED
          )
        }
        writer.drawLine(line, textLeft, writer.y, size)
        writer.y += lineHeight
      })
      writer.y += 3
    }

    if (truncated) {
      writer.paragraph(formatMessage(t.pdfTranscriptTruncated, { count: String(limit) }), {
        base: chromeBase,
        size: 9.5,
        color: MUTED,
      })
    }
  }

  if (writer.missingGlyphs > 0) {
    writer.y += 6
    writer.paragraph(formatMessage(t.pdfUnsupportedGlyphs, { count: String(writer.missingGlyphs) }), {
      base: chromeBase,
      size: 8.5,
      color: MUTED,
    })
  }

  // Page chrome (second pass over the buffered pages): header title, "Page n of N".
  const range = doc.bufferedPageRange()
  const total = range.count
  const missingGlyphs = writer.missingGlyphs
  const headerLine = writer.layout(title, { base: directionFor(meeting.language, meeting.title), size: 8 }, CONTENT_WIDTH)[0]

  for (let index = 0; index < total; index++) {
    doc.switchToPage(range.start + index)

    if (headerLine && index > 0) writer.drawLine(headerLine, MARGIN_X, 30, 8, MUTED)

    const [footer] = writer.layout(
      formatMessage(t.pdfPageOf, { page: String(index + 1), total: String(total) }),
      { base: chromeBase, size: 8, align: "center" },
      CONTENT_WIDTH
    )

    if (footer) writer.drawLine(footer, MARGIN_X, PAGE_HEIGHT - 40, 8, MUTED)
  }

  doc.end()

  return { buffer: await done, pages: total, missingGlyphs, truncated }
}

/** `renderMeetingPdf(meeting, { locale, timeZone })` (M9 B2). */
export async function renderMeetingPdf(meeting: MeetingRecord, options: MeetingPdfOptions = {}): Promise<Buffer> {
  return (await renderMeetingPdfDetailed(meeting, options)).buffer
}
