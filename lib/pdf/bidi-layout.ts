import bidiFactory from "bidi-js"

/**
 * Bidi-aware paragraph layout for the PDF export (M9 B1, docs/parity/m9.md).
 * Pure: fonts are reached only through the injected `measure` and `supports`.
 *
 * 1. Every grapheme cluster gets a font: Hebrew → `hebrew`, Latin → `sans`,
 *    a timecode wrapped in LRI…PDI → `mono`; neutrals follow the preceding
 *    strong cluster (else the paragraph default). A cluster no font can draw
 *    becomes U+25A1 and is counted.
 * 2. Lines break greedily in **logical** order: after a space, or after a
 *    hyphen/maqaf inside a word; never next to a word joiner or NBSP.
 * 3. Each line is reordered **visually** with bidi-js (UAX #9 levels for the
 *    whole paragraph, L1/L2 per line), then repaired so every grapheme cluster
 *    keeps its logical code-unit order (niqqud stays on its letter), and
 *    characters at odd levels are mirrored (brackets).
 * 4. Visual runs (same font) get x offsets from the line's left edge; an RTL
 *    paragraph is right-aligned in the box.
 *
 * Bidi control characters (LRM, RLM, isolates, WJ) steer the algorithm but are
 * never drawn.
 */

export type PdfFontFamily = "hebrew" | "sans" | "mono"
export type PdfFontWeight = "regular" | "bold"
export type PdfFontRef = { family: PdfFontFamily; weight: PdfFontWeight }

export type MeasureText = (text: string, font: PdfFontRef, size: number) => number
export type SupportsCodePoint = (codePoint: number, font: PdfFontRef) => boolean

export type BidiSpan = { text: string; bold?: boolean }

export type LayoutRun = { text: string; font: PdfFontRef; x: number; width: number }
export type LayoutLine = { runs: LayoutRun[]; width: number; x: number }
export type ParagraphLayout = { lines: LayoutLine[]; missingGlyphs: number }

export type LayoutOptions = {
  base: "rtl" | "ltr"
  /** Box width in points. */
  width: number
  /** Font size in points. */
  size: number
  measure: MeasureText
  supports?: SupportsCodePoint
  /** Horizontal placement inside the box; defaults to the base direction's start. */
  align?: "start" | "center"
}

export const MISSING_GLYPH = "□"

const bidi = bidiFactory()

const HEBREW_CHAR = /[֐-׿יִ-ﭏ]/
const LATIN_LETTER = /\p{Script=Latin}/u
const STRONG_OTHER = /[\p{L}]/u
/** Steer bidi, never drawn: ALM, LRM, RLM, embeddings/overrides, isolates, WJ, ZWSP, BOM. */
const INVISIBLE = /^[؜​‎‏‪-‮⁠⁦-⁩﻿]$/
const WJ = "⁠"
const NBSP = " "
const HYPHENS = new Set(["-", "־", "‐"])
const ISOLATED_TIMECODE = /⁦(\d{1,2}:\d{2}(?::\d{2})?)⁩/g
const FALLBACK_ORDER: Record<PdfFontFamily, PdfFontFamily[]> = {
  hebrew: ["hebrew", "sans", "mono"],
  sans: ["sans", "hebrew", "mono"],
  mono: ["mono", "sans", "hebrew"],
}

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" })

/** One code unit of the prepared paragraph. */
type Unit = { family: PdfFontFamily; bold: boolean; cluster: number; invisible: boolean }

type Prepared = { text: string; units: Unit[]; missingGlyphs: number }

function naturalFamily(cluster: string): PdfFontFamily | null {
  if (HEBREW_CHAR.test(cluster)) return "hebrew"
  if (LATIN_LETTER.test(cluster)) return "sans"
  if (STRONG_OTHER.test(cluster)) return "sans"
  return null
}

function spansOf(input: string | BidiSpan[]): BidiSpan[] {
  return typeof input === "string" ? [{ text: input }] : input
}

/**
 * Concatenates the spans, assigns a font family per grapheme cluster and
 * replaces clusters no font can draw with U+25A1.
 */
function prepare(input: string | BidiSpan[], base: "rtl" | "ltr", supports?: SupportsCodePoint): Prepared {
  const spans = spansOf(input)
  const raw = spans.map((span) => span.text.replace(/[\t\r\n\f\v]/g, " ")).join("")
  const rawBold: boolean[] = []

  for (const span of spans) {
    for (let i = 0; i < span.text.length; i++) rawBold.push(span.bold === true)
  }

  const mono = new Uint8Array(raw.length)

  for (const match of raw.matchAll(ISOLATED_TIMECODE)) {
    const start = (match.index ?? 0) + 1

    mono.fill(1, start, start + match[1]!.length)
  }

  const fallback: PdfFontFamily = base === "rtl" ? "hebrew" : "sans"
  let previousStrong: PdfFontFamily | null = null
  let text = ""
  const units: Unit[] = []
  let cluster = 0
  let missingGlyphs = 0

  for (const { segment, index } of graphemes.segment(raw)) {
    const bold = rawBold[index] ?? false
    const invisible = INVISIBLE.test(segment)
    const natural = naturalFamily(segment)
    let family: PdfFontFamily = mono[index] ? "mono" : (natural ?? previousStrong ?? fallback)
    let output = segment

    if (natural && !mono[index]) previousStrong = natural

    if (!invisible && supports && segment !== " " && segment !== NBSP) {
      const codePoints = [...segment].map((char) => char.codePointAt(0)!)
      const usable = FALLBACK_ORDER[family].find((candidate) =>
        codePoints.every((cp) => supports(cp, { family: candidate, weight: bold ? "bold" : "regular" }))
      )

      if (usable) {
        family = usable
      } else {
        output = MISSING_GLYPH
        missingGlyphs += 1
      }
    }

    for (let i = 0; i < output.length; i++) units.push({ family, bold, cluster, invisible })
    text += output
    cluster += 1
  }

  return { text, units, missingGlyphs }
}

function fontOf(unit: Unit): PdfFontRef {
  return { family: unit.family, weight: unit.bold ? "bold" : "regular" }
}

function sameFont(a: PdfFontRef, b: PdfFontRef): boolean {
  return a.family === b.family && a.weight === b.weight
}

/** Logical width of `text[start, end)`, measured per font run, invisibles skipped. */
function measureRange(prepared: Prepared, start: number, end: number, size: number, measure: MeasureText): number {
  let width = 0
  let runFont: PdfFontRef | null = null
  let runText = ""

  const flush = () => {
    if (runFont && runText) width += measure(runText, runFont, size)
    runText = ""
    runFont = null
  }

  for (let i = start; i < end; i++) {
    const unit = prepared.units[i]!

    if (unit.invisible) continue

    const font = fontOf(unit)

    if (!runFont || !sameFont(runFont, font)) {
      flush()
      runFont = font
    }

    runText += prepared.text[i] === NBSP ? " " : prepared.text[i]
  }

  flush()

  return width
}

/** Code-unit indices before which a line may break. */
function breakOpportunities(text: string): number[] {
  const breaks: number[] = []

  for (let i = 1; i < text.length; i++) {
    const before = text[i - 1]!
    const at = text[i]!

    if (before === WJ || at === WJ || before === NBSP || at === NBSP) continue

    if (before === " " && at !== " ") {
      breaks.push(i)
    } else if (HYPHENS.has(before) && at !== " " && i >= 2 && /[\p{L}\p{N}]/u.test(text[i - 2]!)) {
      breaks.push(i)
    }
  }

  return breaks
}

function trimEndSpaces(text: string, start: number, end: number): number {
  let stop = end

  while (stop > start && (text[stop - 1] === " " || INVISIBLE.test(text[stop - 1]!))) stop -= 1

  return stop
}

/** Greedy logical line breaking; returns `[start, end)` ranges (trailing spaces excluded). */
function breakLines(prepared: Prepared, options: LayoutOptions): Array<[number, number]> {
  const { text } = prepared
  const cuts = [0, ...breakOpportunities(text), text.length]
  const lines: Array<[number, number]> = []
  let lineStart = 0
  let lineEnd = 0
  let lineWidth = 0

  const measure = (start: number, end: number) => measureRange(prepared, start, end, options.size, options.measure)

  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i]!
    const end = cuts[i + 1]!
    const trimmed = trimEndSpaces(text, start, end)
    const pieceWidth = measure(start, trimmed)
    const fullWidth = trimmed === end ? pieceWidth : measure(start, end)

    if (lineEnd > lineStart && lineWidth + pieceWidth > options.width) {
      lines.push([lineStart, trimEndSpaces(text, lineStart, lineEnd)])
      lineStart = start
      lineWidth = 0
    }

    if (pieceWidth > options.width) {
      // A single piece wider than the box: break it by grapheme cluster.
      let chunkStart = start
      let chunkWidth = 0

      for (let j = start; j < trimmed; ) {
        const cluster = prepared.units[j]!.cluster
        let next = j + 1

        while (next < trimmed && prepared.units[next]!.cluster === cluster) next += 1

        const width = measure(j, next)

        if (chunkWidth + width > options.width && j > chunkStart) {
          lines.push([chunkStart, j])
          chunkStart = j
          chunkWidth = 0
        }

        chunkWidth += width
        j = next
      }

      lineStart = chunkStart
      lineEnd = end
      lineWidth = chunkWidth + (fullWidth - pieceWidth)
      continue
    }

    lineEnd = end
    lineWidth += fullWidth
  }

  if (trimEndSpaces(text, lineStart, lineEnd) > lineStart || lines.length === 0) {
    lines.push([lineStart, trimEndSpaces(text, lineStart, lineEnd)])
  }

  return lines
}

/**
 * Visual order of `text[start, end)`: bidi-js L1/L2 reordering, then every
 * grapheme cluster restored to its logical code-unit order.
 */
function visualIndices(
  prepared: Prepared,
  levels: ReturnType<typeof bidi.getEmbeddingLevels>,
  start: number,
  end: number
): number[] {
  if (end <= start) return []

  const order = bidi.getReorderedIndices(prepared.text, levels, start, end - 1).slice(start, end)
  const repaired: number[] = []

  for (let i = 0; i < order.length; ) {
    const cluster = prepared.units[order[i]!]!.cluster
    let j = i + 1

    while (j < order.length && prepared.units[order[j]!]!.cluster === cluster) j += 1

    repaired.push(...order.slice(i, j).sort((a, b) => a - b))
    i = j
  }

  return repaired
}

/** Lays out one paragraph (a `\n` starts a new bidi paragraph with the same base). */
export function layoutParagraph(input: string | BidiSpan[], options: LayoutOptions): ParagraphLayout {
  const spans = spansOf(input)
  const blocks: BidiSpan[][] = [[]]

  for (const span of spans) {
    const parts = span.text.split("\n")

    parts.forEach((part, index) => {
      if (index > 0) blocks.push([])
      if (part) blocks[blocks.length - 1]!.push({ text: part, bold: span.bold })
    })
  }

  const lines: LayoutLine[] = []
  let missingGlyphs = 0

  for (const block of blocks) {
    const result = layoutBlock(block, options)

    lines.push(...result.lines)
    missingGlyphs += result.missingGlyphs
  }

  return { lines, missingGlyphs }
}

function layoutBlock(spans: BidiSpan[], options: LayoutOptions): ParagraphLayout {
  const prepared = prepare(spans, options.base, options.supports)

  if (!prepared.text.trim()) return { lines: [{ runs: [], width: 0, x: 0 }], missingGlyphs: prepared.missingGlyphs }

  const levels = bidi.getEmbeddingLevels(prepared.text, options.base)
  const mirrored = bidi.getMirroredCharactersMap(prepared.text, levels.levels)
  const lines: LayoutLine[] = []

  for (const [start, end] of breakLines(prepared, options)) {
    const runs: LayoutRun[] = []
    let current: { text: string; font: PdfFontRef } | null = null

    for (const index of visualIndices(prepared, levels, start, end)) {
      const unit = prepared.units[index]!

      if (unit.invisible) continue

      const font = fontOf(unit)
      const raw = mirrored.get(index) ?? prepared.text[index]!
      const char = raw === NBSP ? " " : raw

      if (current && sameFont(current.font, font)) {
        current.text += char
      } else {
        current = { text: char, font }
        runs.push({ text: char, font, x: 0, width: 0 })
      }

      runs[runs.length - 1]!.text = current.text
    }

    let x = 0

    for (const run of runs) {
      run.width = options.measure(run.text, run.font, options.size)
      run.x = x
      x += run.width
    }

    const lineX =
      options.align === "center"
        ? Math.max(0, (options.width - x) / 2)
        : options.base === "rtl"
          ? Math.max(0, options.width - x)
          : 0

    lines.push({ runs, width: x, x: lineX })
  }

  return { lines, missingGlyphs: prepared.missingGlyphs }
}

/** The visual string of each line (tests and debugging). */
export function visualLines(layout: ParagraphLayout): string[] {
  return layout.lines.map((line) => line.runs.map((run) => run.text).join(""))
}
