/**
 * Snippets and highlight offsets (docs/parity/m6.md, B4; owner: Package B).
 *
 * Matching runs on `foldWithOffsets(text)` (A's normalizer is the only
 * folding authority) and is mapped back to the original text, so a
 * prefix-stripped match highlights the whole surface word (`בתקציב`) and
 * niqqud stays inside the mark. Offsets are UTF-16 code units.
 */
import { foldWithOffsets, hebrewPrefixVariants } from "@/lib/search/hebrew-normalize"
import { activeTokens } from "@/lib/search/query"
import type { MeetingChunk, NormalizedQuery, QueryToken } from "@/lib/search/types"

export const DEFAULT_SNIPPET_WINDOW = 240
const ELLIPSIS = "…"
const WORD = /[\p{L}\p{N}]+(?:\.[\p{N}]+)*/gu

type Lexeme = { value: string; prefix: boolean }

function lexemes(nq: NormalizedQuery): Lexeme[] {
  const out: Lexeme[] = []

  for (const token of activeTokens(nq)) {
    for (const value of [token.raw, ...token.variants]) {
      if (value) out.push({ value, prefix: prefixable(value, token) })
    }
  }

  return out
}

function prefixable(value: string, token: QueryToken) {
  return token.script !== "number" && [...value].length >= 3
}

function wordMatches(word: string, query: Lexeme[]): boolean {
  const forms = [word, ...hebrewPrefixVariants(word)]

  return query.some((lexeme) =>
    forms.some((form) => form === lexeme.value || (lexeme.prefix && form.startsWith(lexeme.value)))
  )
}

/** Matched surface ranges `[start, end)` in the original `text`. */
export function findMatches(text: string, nq: NormalizedQuery): [number, number][] {
  const query = lexemes(nq)

  if (!query.length || !text) return []

  const { folded, map } = foldWithOffsets(text)
  const ranges: [number, number][] = []

  for (const match of folded.matchAll(WORD)) {
    const start = match.index ?? 0
    const end = start + match[0].length

    if (!wordMatches(match[0], query)) continue

    const from = map[start] ?? 0
    let to = end < folded.length ? (map[end] ?? text.length) : text.length

    while (to > from && /[\s\p{P}\p{Z}\p{S}]/u.test(text[to - 1])) to -= 1
    if (to > from) ranges.push([from, to])
  }

  return mergeRanges(ranges)
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]

    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }

  return merged
}

function isLowSurrogate(text: string, index: number) {
  const code = text.charCodeAt(index)

  return code >= 0xdc00 && code <= 0xdfff
}

export type Snippet = {
  snippet: string
  highlights: [number, number][]
  /** Offset of the first highlight in the original text (citation segment). */
  matchOffset?: number
}

export function buildSnippet(
  text: string,
  nq: NormalizedQuery,
  options: { window?: number } = {}
): Snippet {
  const window = Math.max(20, options.window ?? DEFAULT_SNIPPET_WINDOW)
  const matches = findMatches(text, nq)
  let spanStart = 0
  let spanEnd = 0

  if (matches.length) {
    let best = { i: 0, j: 0, count: 0 }

    for (let i = 0; i < matches.length; i += 1) {
      let j = i

      while (j + 1 < matches.length && matches[j + 1][1] - matches[i][0] <= window) j += 1
      if (j - i + 1 > best.count) best = { i, j, count: j - i + 1 }
    }
    spanStart = matches[best.i][0]
    spanEnd = Math.min(matches[best.j][1], spanStart + window)
  }

  let start = Math.max(0, spanStart - Math.floor((window - (spanEnd - spanStart)) / 2))
  let end = Math.min(text.length, start + window)

  start = Math.max(0, Math.min(start, end - window))

  if (start > 0) {
    const space = text.slice(start, spanStart).search(/\s/)

    if (space >= 0) start += space + 1
  }
  if (end < text.length) {
    const tail = text.slice(spanEnd, end)
    const space = tail.search(/\s\S*$/)

    if (space >= 0) end = spanEnd + space
  }
  while (start < end && /\s/.test(text[start])) start += 1
  while (end > start && /\s/.test(text[end - 1])) end -= 1
  if (start > 0 && isLowSurrogate(text, start)) start += 1
  if (end < text.length && isLowSurrogate(text, end)) end -= 1

  const lead = start > 0 ? ELLIPSIS : ""
  const trail = end < text.length ? ELLIPSIS : ""
  const highlights = matches
    .filter(([from, to]) => from >= start && to <= end)
    .map(([from, to]) => [from - start + lead.length, to - start + lead.length] as [number, number])

  return {
    snippet: `${lead}${text.slice(start, end)}${trail}`,
    highlights,
    matchOffset: matches[0]?.[0],
  }
}

/**
 * The chunk's own segment (overlap skipped) containing `offset` of the chunk
 * text, for click-to-seek; the first own segment when `offset` is unknown or
 * falls in the overlap.
 */
export function pickCitationSegment(
  chunk: Pick<MeetingChunk, "segmentIds" | "segmentStartMs" | "segmentOffsets" | "overlapCount">,
  offset: number | undefined
): { segmentId: string; startMs: number } | undefined {
  const count = chunk.segmentIds.length

  if (!count) return undefined

  const first = Math.min(Math.max(chunk.overlapCount, 0), count - 1)
  let index = first

  if (offset !== undefined) {
    for (let i = first; i < count; i += 1) {
      if ((chunk.segmentOffsets[i] ?? Number.POSITIVE_INFINITY) <= offset) index = i
      else break
    }
  }

  return { segmentId: chunk.segmentIds[index], startMs: chunk.segmentStartMs[index] ?? 0 }
}
