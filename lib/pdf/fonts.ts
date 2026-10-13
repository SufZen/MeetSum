import { readFileSync } from "node:fs"
import path from "node:path"

import PDFDocument from "pdfkit"

import type { PdfFontFamily, PdfFontRef, PdfFontWeight } from "@/lib/pdf/bidi-layout"

/**
 * Plex fonts for the PDF export (M9 B2). One source with the UI: the TTFs
 * vendored in `assets/fonts/ttf` (IBM Plex 1.1.0; assets/fonts/README.md),
 * overridable with `MEETSUM_PDF_FONT_DIR`. Each face is parsed once per
 * process and cached.
 *
 * Text arrives at pdfkit already in **visual** order (lib/pdf/bidi-layout.ts),
 * but fontkit would reverse every Hebrew word again (it treats Hebrew script
 * as RTL). Each cached face therefore lays out as LTR: shaping (GPOS
 * niqqud placement, kerning) still runs for the script, only the final
 * reversal is skipped. Measuring and drawing use the same faces, so widths
 * match exactly.
 */

const FILES: Record<PdfFontFamily, Record<PdfFontWeight, string>> = {
  hebrew: { regular: "IBMPlexSansHebrew-Regular.ttf", bold: "IBMPlexSansHebrew-SemiBold.ttf" },
  sans: { regular: "IBMPlexSans-Regular.ttf", bold: "IBMPlexSans-SemiBold.ttf" },
  mono: { regular: "IBMPlexMono-Regular.ttf", bold: "IBMPlexMono-Medium.ttf" },
}

type GlyphRun = { advanceWidth: number }

/** The fontkit surface used here (pdfkit accepts any object with `layout`). */
export type PdfFace = {
  postscriptName: string
  unitsPerEm: number
  layout(text: string, features?: unknown, ...rest: unknown[]): GlyphRun
  hasGlyphForCodePoint(codePoint: number): boolean
}

const cache = new Map<string, PdfFace>()

export function pdfFontDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MEETSUM_PDF_FONT_DIR?.trim()

  return override ? path.resolve(override) : path.join(process.cwd(), "assets", "fonts", "ttf")
}

export function pdfFontKey(font: PdfFontRef): string {
  return `${font.family}-${font.weight}`
}

export function pdfFontFile(font: PdfFontRef): string {
  return FILES[font.family][font.weight]
}

/**
 * Parses a TTF through pdfkit's own fontkit (pdfkit is the declared
 * dependency; fontkit is its internal one) and pins the layout direction.
 */
function parseFace(buffer: Buffer): PdfFace {
  const scratch = new PDFDocument({ autoFirstPage: false, font: null as unknown as string })
  const face = (scratch.font(buffer) as unknown as { _font: { font: PdfFace } })._font.font
  const original = face.layout.bind(face)

  face.layout = (text: string, features?: unknown) => original(text, features, undefined, undefined, "ltr")

  return face
}

export function loadPdfFace(font: PdfFontRef, env: NodeJS.ProcessEnv = process.env): PdfFace {
  const file = path.join(pdfFontDir(env), pdfFontFile(font))
  const cached = cache.get(file)

  if (cached) return cached

  const face = parseFace(readFileSync(file))

  cache.set(file, face)

  return face
}

/** Advance width in points (the same layout pdfkit draws with). */
export function measurePdfText(face: PdfFace, text: string, size: number): number {
  if (!text) return 0

  return (face.layout(text).advanceWidth * size) / face.unitsPerEm
}
