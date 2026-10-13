/**
 * Bidi-safe snippet highlighting (docs/parity/m6.md, D1; owner: Package D).
 * Pure and client-safe: it returns plain text parts that the caller renders
 * as React text nodes (`<mark>`, `<bdi>`), never HTML, so snippet text such
 * as `<img onerror>` always stays text.
 *
 * - Highlight ranges are UTF-16 `[start, end)` offsets (B4). They are
 *   clamped, sorted, merged when they overlap or touch, and snapped outward
 *   so a range never splits a surrogate pair.
 * - A mark whose script direction differs from its container's is isolated
 *   (`<bdi>`), so an English term inside a Hebrew line (or the reverse)
 *   can't reorder its neighbours.
 */
import type { TextLanguage } from "@/lib/search/types"

export type TextDir = "rtl" | "ltr"

export type HighlightPart = {
  text: string
  mark: boolean
  /** Wrap in `<bdi>` (its direction differs from the container's). */
  isolate: boolean
  /** The part's own strong direction, when it has one. */
  dir?: TextDir
}

const RTL_LANGUAGES = new Set(["he", "iw", "yi", "ar", "fa", "ur"])
// Hebrew, Arabic, Syriac, Thaana, NKo and the RTL presentation forms.
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/

/** Direction of a known language code (`he`, `en-US`…); undefined for mixed or unknown. */
export function dirForLanguage(language?: string | null): TextDir | undefined {
  const code = language?.toLowerCase().split(/[-_]/)[0]

  if (!code || code === "mixed" || code === "auto" || code === "unknown" || code === "und") return undefined

  return RTL_LANGUAGES.has(code) ? "rtl" : "ltr"
}

/**
 * `dir` for a search result: from the hit's language, `mixed` falls back to
 * the meeting language, and `auto` only when neither is known.
 */
export function hitDir(hitLanguage?: TextLanguage | null, meetingLanguage?: string | null): TextDir | "auto" {
  if (hitLanguage === "he") return "rtl"
  if (hitLanguage === "en") return "ltr"

  return dirForLanguage(meetingLanguage) ?? "auto"
}

/** Direction of the first strong character (what `dir="auto"` would pick). */
export function strongDirection(text: string): TextDir | undefined {
  for (const char of text) {
    if (RTL_CHAR.test(char)) return "rtl"
    if (LTR_CHAR.test(char)) return "ltr"
  }

  return undefined
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Clamped, sorted, merged and surrogate-safe ranges. */
export function normalizeRanges(text: string, ranges: readonly (readonly [number, number])[]): [number, number][] {
  const length = text.length
  const cleaned: [number, number][] = []

  for (const range of ranges) {
    if (!Array.isArray(range) || range.length < 2) continue

    let start = Math.max(0, Math.min(length, Math.floor(Number(range[0]))))
    let end = Math.max(0, Math.min(length, Math.ceil(Number(range[1]))))

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue

    // Never split a surrogate pair: widen to the whole code point.
    if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start -= 1
    if (end < length && isLowSurrogate(text.charCodeAt(end)) && isHighSurrogate(text.charCodeAt(end - 1))) end += 1

    cleaned.push([start, end])
  }

  cleaned.sort((a, b) => a[0] - b[0] || a[1] - b[1])

  const merged: [number, number][] = []

  for (const range of cleaned) {
    const last = merged[merged.length - 1]

    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }

  return merged
}

/**
 * Splits `text` into plain and marked parts. `containerDir` is the `dir` of
 * the element the parts render in.
 */
export function highlightParts(
  text: string,
  ranges: readonly (readonly [number, number])[],
  containerDir: TextDir | "auto"
): HighlightPart[] {
  const parts: HighlightPart[] = []
  let cursor = 0

  const push = (value: string, mark: boolean) => {
    if (!value) return

    const dir = strongDirection(value)
    const isolate = mark && dir !== undefined && (containerDir === "auto" || dir !== containerDir)

    parts.push({ text: value, mark, isolate, ...(dir ? { dir } : {}) })
  }

  for (const [start, end] of normalizeRanges(text, ranges)) {
    push(text.slice(cursor, start), false)
    push(text.slice(start, end), true)
    cursor = end
  }
  push(text.slice(cursor), false)

  return parts
}
