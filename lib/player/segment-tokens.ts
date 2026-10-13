/**
 * Render tokens for one transcript segment (M4, client-safe, pure).
 *
 * The segment text is the source of truth for what is shown; word timings
 * are attached to the text's whitespace-separated tokens (one-to-one when the
 * counts match, otherwise by folded equality, so a manual edit that adds or
 * drops words still lights the words it kept). Search marks split tokens at
 * their boundaries. Word languages different from the segment's drive `<bdi>`
 * runs, never the paragraph direction.
 */
import { normalizeForSearch } from "@/lib/player/transcript-search"

export type TokenWord = {
  startMs: number
  endMs: number
  text: string
  language?: string
}

export type TokenMark = { start: number; end: number; matchIndex: number }

export type SegmentToken = {
  text: string
  /** Original text offsets. */
  start: number
  end: number
  whitespace?: boolean
  /** Index into the segment's words when this token is a timed word. */
  wordIndex?: number
  /** Word language when it differs from the segment language. */
  lang?: string
  /** Search match covering this token piece. */
  markIndex?: number
}

type RawToken = { text: string; start: number; end: number; whitespace: boolean }

function splitWhitespace(text: string): RawToken[] {
  const tokens: RawToken[] = []
  const pattern = /\s+|\S+/gu
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      whitespace: /^\s/u.test(match[0]),
    })
  }

  return tokens
}

function foldKey(text: string): string {
  return normalizeForSearch(text)
    .text.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
}

/** Maps each non-whitespace token position to a word index (or undefined). */
function alignWords(tokens: string[], words: readonly TokenWord[]): (number | undefined)[] {
  if (tokens.length === words.length) return tokens.map((_, index) => index)

  const result: (number | undefined)[] = new Array(tokens.length).fill(undefined)
  const wordKeys = words.map((word) => foldKey(word.text))
  const LOOKAHEAD = 6
  let wordCursor = 0

  for (let tokenIndex = 0; tokenIndex < tokens.length && wordCursor < words.length; tokenIndex += 1) {
    const key = foldKey(tokens[tokenIndex])

    if (!key) continue

    for (let offset = 0; offset < LOOKAHEAD && wordCursor + offset < words.length; offset += 1) {
      if (wordKeys[wordCursor + offset] === key) {
        result[tokenIndex] = wordCursor + offset
        wordCursor += offset + 1
        break
      }
    }
  }

  return result
}

export function buildSegmentTokens(
  text: string,
  words?: readonly TokenWord[],
  marks: readonly TokenMark[] = []
): SegmentToken[] {
  const raw = splitWhitespace(text)
  const wordTokens = raw.filter((token) => !token.whitespace)
  const alignment = words?.length ? alignWords(wordTokens.map((token) => token.text), words) : []
  const tokens: SegmentToken[] = []
  let wordPosition = 0

  for (const token of raw) {
    const wordIndex = token.whitespace ? undefined : alignment[wordPosition]
    const lang = wordIndex !== undefined ? words?.[wordIndex]?.language : undefined

    if (!token.whitespace) wordPosition += 1

    // Split at mark boundaries inside this token.
    const cuts = new Set<number>([token.start, token.end])

    for (const mark of marks) {
      if (mark.end <= token.start || mark.start >= token.end) continue
      if (mark.start > token.start) cuts.add(mark.start)
      if (mark.end < token.end) cuts.add(mark.end)
    }

    const points = [...cuts].sort((a, b) => a - b)

    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]
      const end = points[index + 1]
      const mark = marks.find((candidate) => candidate.start <= start && candidate.end >= end)
      const piece: SegmentToken = { text: text.slice(start, end), start, end }

      if (token.whitespace) piece.whitespace = true
      if (wordIndex !== undefined) piece.wordIndex = wordIndex
      if (lang) piece.lang = lang
      if (mark) piece.markIndex = mark.matchIndex
      tokens.push(piece)
    }
  }

  return tokens
}

export type LanguageRun = { lang?: string; tokens: SegmentToken[] }

/**
 * Groups tokens into runs of the same foreign language so each English run
 * renders inside one `<bdi>`. Whitespace between two tokens of the same
 * foreign language stays inside the run; other whitespace belongs to the
 * surrounding (segment-language) text.
 */
export function groupLanguageRuns(tokens: readonly SegmentToken[]): LanguageRun[] {
  const runs: LanguageRun[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    let lang = token.lang

    if (token.whitespace) {
      const previous = runs.at(-1)?.lang
      const next = tokens.slice(index + 1).find((candidate) => !candidate.whitespace)?.lang

      lang = previous && previous === next ? previous : undefined
    }

    const current = runs.at(-1)

    if (current && current.lang === lang) current.tokens.push(token)
    else runs.push({ lang, tokens: [token] })
  }

  return runs
}
