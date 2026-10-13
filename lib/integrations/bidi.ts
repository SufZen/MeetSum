/**
 * Bidi helpers for text pushed to providers without RTL support (Slack,
 * Notion, plain-text email, HubSpot fallbacks) and the shared chunker
 * (docs/parity/m8.md, "Shared contracts"). Since M9 the primitives live in
 * `lib/i18n/hebrew-text.ts` (canonical) and are re-exported here with the
 * same names and behaviour; this module keeps only the M8-specific helpers
 * (`isolateLtr(token, mode)` as an adapter, `chunkText`). Pure.
 */
import { LRM, isolateLtr as isolateRun } from "@/lib/i18n/hebrew-text"

export { LRI, LRM, PDI, RLM, firstStrongDirection, isRtlLanguage, rtlLine } from "@/lib/i18n/hebrew-text"

/**
 * Keeps an LTR token (time, email, URL label, number) intact inside RTL
 * text. `marks` wraps it in LRM (works everywhere, e.g. Slack mrkdwn);
 * `isolates` uses LRI…PDI (Docs, DOCX, HTML-capable targets).
 */
export function isolateLtr(token: string, mode: "marks" | "isolates"): string {
  if (!token) return token

  return mode === "marks" ? `${LRM}${token}${LRM}` : isolateRun(token)
}

// ---------------------------------------------------------------------------
// chunkText

type Segmenter = { segment(input: string): Iterable<{ index: number; segment: string }> }

function segmentEnds(text: string, granularity: "sentence" | "word" | "grapheme"): number[] {
  const SegmenterCtor = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter })
    .Segmenter

  if (!SegmenterCtor) {
    // Without Intl.Segmenter: code point boundaries (never splits a surrogate pair).
    return granularity === "grapheme" ? codePointEnds(text) : []
  }

  const ends: number[] = []

  for (const { index, segment } of new SegmenterCtor(undefined, { granularity }).segment(text)) {
    ends.push(index + segment.length)
  }

  return ends
}

function codePointEnds(text: string): number[] {
  const ends: number[] = []
  let offset = 0

  for (const char of text) {
    offset += char.length
    ends.push(offset)
  }

  return ends
}

function paragraphEnds(text: string): number[] {
  const ends: number[] = []

  for (const match of text.matchAll(/\n[ \t]*\n\s*/g)) {
    ends.push((match.index ?? 0) + match[0].length)
  }

  return ends
}

/** Largest boundary b with lo < b ≤ hi in an ascending list, else undefined. */
function lastBoundary(sorted: readonly number[], lo: number, hi: number): number | undefined {
  let left = 0
  let right = sorted.length - 1
  let found: number | undefined

  while (left <= right) {
    const mid = (left + right) >> 1

    if (sorted[mid] <= hi) {
      found = sorted[mid]
      left = mid + 1
    } else {
      right = mid - 1
    }
  }

  return found !== undefined && found > lo ? found : undefined
}

const WHITESPACE = /\s/

/**
 * Splits `text` into chunks of at most `max` UTF-16 code units, preferring
 * paragraph, then sentence, then word, then grapheme boundaries
 * (`Intl.Segmenter`). A surrogate pair or grapheme cluster is never split
 * (a single grapheme longer than `max` falls back to code points; a single
 * code point longer than `max` throws). Whitespace at a split point may be
 * dropped; otherwise joining the chunks reproduces the text exactly.
 * Empty input → `[]`.
 */
export function chunkText(text: string, max: number): string[] {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("chunkText: max must be a positive integer")
  if (!text) return []
  if (text.length <= max) return [text]

  const levels = [
    paragraphEnds(text),
    segmentEnds(text, "sentence"),
    segmentEnds(text, "word"),
    segmentEnds(text, "grapheme"),
    codePointEnds(text),
  ]
  const chunks: string[] = []
  let position = 0

  while (position < text.length) {
    if (text.length - position <= max) {
      chunks.push(text.slice(position))
      break
    }

    const limit = position + max
    let cut: number | undefined

    for (const boundaries of levels) {
      cut = lastBoundary(boundaries, position, limit)
      if (cut !== undefined) break
    }

    if (cut === undefined) throw new RangeError("chunkText: a single character is longer than max")

    const chunk = text.slice(position, cut).trimEnd()

    if (chunk) chunks.push(chunk)
    position = cut
    while (position < text.length && WHITESPACE.test(text[position] as string)) position += 1
  }

  return chunks
}
