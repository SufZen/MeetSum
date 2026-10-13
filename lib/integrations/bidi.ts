/**
 * Bidi helpers for text pushed to providers without RTL support (Slack,
 * Notion, plain-text email, HubSpot fallbacks) and the shared chunker
 * (docs/parity/m8.md, "Shared contracts"). Real in Step 0; owned by
 * Package A afterwards, consumed read-only by B and C. Pure.
 */

/** RIGHT-TO-LEFT MARK. */
export const RLM = "‏"
/** LEFT-TO-RIGHT MARK. */
export const LRM = "‎"
/** LEFT-TO-RIGHT ISOLATE. */
export const LRI = "⁦"
/** POP DIRECTIONAL ISOLATE. */
export const PDI = "⁩"

const RTL_LANGUAGES = new Set(["he", "ar", "fa", "ur", "yi"])

/** `he`, `he-IL`, `ar_EG`… → true; null/unknown → false. */
export function isRtlLanguage(lang: string | null | undefined): boolean {
  if (!lang) return false

  return RTL_LANGUAGES.has(lang.trim().toLowerCase().split(/[-_]/)[0] ?? "")
}

/** Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan… and their presentation forms. */
const STRONG_RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u
const LETTER = /\p{L}/u
/** LRI, RLI, FSI open an isolate (skipped, UBA rule P2); PDI closes it. */
const ISOLATE_OPEN = new Set(["⁦", "⁧", "⁨"])

/**
 * Direction of the first strong character (UBA P2: isolated runs are
 * skipped), or `neutral` when there is none (digits, punctuation, emoji).
 */
export function firstStrongDirection(text: string): "ltr" | "rtl" | "neutral" {
  let depth = 0

  for (const char of text) {
    if (ISOLATE_OPEN.has(char)) {
      depth += 1
      continue
    }
    if (char === PDI) {
      if (depth > 0) depth -= 1
      continue
    }
    if (depth > 0) continue
    if (char === RLM) return "rtl"
    if (char === LRM) return "ltr"
    if (STRONG_RTL.test(char)) return "rtl"
    if (LETTER.test(char)) return "ltr"
  }

  return "neutral"
}

function rtlSingleLine(line: string): string {
  if (!line) return line

  const first = String.fromCodePoint(line.codePointAt(0) as number)

  if (first === RLM || STRONG_RTL.test(first)) return line

  return `${RLM}${line}`
}

/**
 * Makes a line lay out right-to-left in a renderer that picks direction
 * from the first strong character (Slack, Notion, plain text): prefixes RLM
 * unless the line already starts with an RTL character or RLM. Applied per
 * line when the text has line breaks. Marks are only ever added at a line
 * start, never inside URLs or tokens.
 */
export function rtlLine(line: string): string {
  return line.split("\n").map(rtlSingleLine).join("\n")
}

/**
 * Keeps an LTR token (time, email, URL label, number) intact inside RTL
 * text. `marks` wraps it in LRM (works everywhere, e.g. Slack mrkdwn);
 * `isolates` uses LRI…PDI (Docs, DOCX, HTML-capable targets).
 */
export function isolateLtr(token: string, mode: "marks" | "isolates"): string {
  if (!token) return token

  return mode === "marks" ? `${LRM}${token}${LRM}` : `${LRI}${token}${PDI}`
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
