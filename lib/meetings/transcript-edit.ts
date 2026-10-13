import type { TranscriptSegment } from "@/lib/meetings/repository"
import type { TranscriptWord } from "@/lib/meetings/transcript-words"

export type SegmentBounds = { startMs: number; endMs: number }

/** Above this many tokens (after trimming the common prefix/suffix) LCS is skipped. */
export const REALIGN_LCS_MAX_TOKENS = 400

/** Whitespace tokens; punctuation stays attached to its word. */
export function tokenizeEditedText(text: string): string[] {
  return text.trim().split(/\s+/u).filter(Boolean)
}

const SINGLE_QUOTES = /[׳‘’‚‛`´ʼ]/gu
const DOUBLE_QUOTES = /[״“”„‟«»]/gu
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu

/**
 * Comparison key of a word: compatibility-normalized, combining marks
 * (Hebrew niqqud/cantillation, Latin accents) stripped, lowercased, geresh /
 * gershayim / typographic quotes folded to ASCII, edge punctuation stripped.
 * A token that is only punctuation keys to its folded form.
 */
export function wordKey(token: string): string {
  const folded = token
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
  const stripped = folded.replace(EDGE_PUNCTUATION, "")

  return stripped || folded
}

type Timed = { startMs: number; endMs: number }

/**
 * Old words clamped into the segment bounds with integer, non-decreasing
 * starts and end ≥ start (identity for well-formed ASR words).
 */
function sanitizeWords(words: readonly TranscriptWord[], bounds: SegmentBounds): TranscriptWord[] {
  const lo = Math.round(bounds.startMs)
  const hi = Math.max(lo, Math.round(bounds.endMs))
  let previousStart = lo

  return words.map((word) => {
    const start = Math.max(previousStart, Math.min(hi, Math.max(lo, Math.round(word.startMs))))
    const end = Math.max(start, Math.min(hi, Math.round(word.endMs)))

    previousStart = start
    return { ...word, startMs: start, endMs: end }
  })
}

/**
 * Splits [start, end] over `tokens` by character length (min weight 1) into
 * integer, contiguous, non-decreasing spans. A zero-width span yields
 * zero-duration words.
 */
function spread(tokens: readonly string[], start: number, end: number): Timed[] {
  const span = Math.max(0, end - start)
  const weights = tokens.map((token) => Math.max(1, Array.from(token).length))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const spans: Timed[] = []
  let cumulative = 0

  for (const weight of weights) {
    const wordStart = start + Math.round((span * cumulative) / total)

    cumulative += weight
    spans.push({ startMs: wordStart, endMs: start + Math.round((span * cumulative) / total) })
  }

  return spans
}

function editedWord(text: string, timing: Timed): TranscriptWord {
  return { startMs: timing.startMs, endMs: timing.endMs, text, edited: true }
}

/** Index pairs [oldIndex, newIndex] of a longest common subsequence of keys. */
function lcsPairs(oldKeys: readonly string[], newKeys: readonly string[]): Array<[number, number]> {
  const n = oldKeys.length
  const m = newKeys.length
  const width = m + 1
  const table = new Uint16Array((n + 1) * width)

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldKeys[i] === newKeys[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }

  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0

  while (i < n && j < m) {
    if (oldKeys[i] === newKeys[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }

  return pairs
}

/**
 * Anchors (old index → new index): the common prefix and suffix, plus an LCS
 * of the middle when it is small enough.
 */
function anchorPairs(oldKeys: readonly string[], newKeys: readonly string[]): Array<[number, number]> {
  let prefix = 0

  while (prefix < oldKeys.length && prefix < newKeys.length && oldKeys[prefix] === newKeys[prefix]) {
    prefix += 1
  }

  let suffix = 0

  while (
    suffix < oldKeys.length - prefix &&
    suffix < newKeys.length - prefix &&
    oldKeys[oldKeys.length - 1 - suffix] === newKeys[newKeys.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const pairs: Array<[number, number]> = []

  for (let index = 0; index < prefix; index += 1) pairs.push([index, index])

  const oldMiddle = oldKeys.slice(prefix, oldKeys.length - suffix)
  const newMiddle = newKeys.slice(prefix, newKeys.length - suffix)

  if (
    oldMiddle.length &&
    newMiddle.length &&
    oldMiddle.length <= REALIGN_LCS_MAX_TOKENS &&
    newMiddle.length <= REALIGN_LCS_MAX_TOKENS
  ) {
    for (const [i, j] of lcsPairs(oldMiddle, newMiddle)) pairs.push([i + prefix, j + prefix])
  }

  for (let index = suffix; index > 0; index -= 1) {
    pairs.push([oldKeys.length - index, newKeys.length - index])
  }

  return pairs
}

/**
 * Re-times the words of an edited segment (M4) so untouched words keep their
 * ASR timings:
 *
 * - tokens are whitespace-separated (punctuation attached) and compared by
 *   `wordKey` (niqqud-, case-, quote- and edge-punctuation-insensitive);
 * - anchors are the LCS of old and new keys (common prefix/suffix first; a
 *   middle above 400 tokens is not aligned and is re-timed proportionally);
 * - matched tokens keep their timings with the new surface text (`edited`
 *   and no confidence only when the surface changed);
 * - each unmatched run takes the span of the old words it replaced, else the
 *   gap between its anchors, split by character length into integer ms (a
 *   zero-width gap gives zero-duration words); its words are `edited`;
 * - legacy segments without words are spread proportionally, all edited.
 *
 * Invariants: one word per token, starts non-decreasing, end ≥ start, all
 * within `bounds` (the segment bounds themselves never change), confidence
 * dropped on edited words.
 */
export function realignWords(
  oldWords: readonly TranscriptWord[] | undefined,
  newText: string,
  bounds: SegmentBounds
): TranscriptWord[] {
  const tokens = tokenizeEditedText(newText)

  if (!tokens.length) return []

  const lo = Math.round(bounds.startMs)
  const hi = Math.max(lo, Math.round(bounds.endMs))

  if (!oldWords?.length) {
    return spread(tokens, lo, hi).map((timing, index) => editedWord(tokens[index], timing))
  }

  const old = sanitizeWords(oldWords, bounds)
  const pairs = anchorPairs(
    old.map((word) => wordKey(word.text)),
    tokens.map(wordKey)
  )
  const result = new Array<TranscriptWord>(tokens.length)

  for (const [i, j] of pairs) {
    const word = old[i]

    if (word.text === tokens[j]) {
      result[j] = { ...word }
    } else {
      const changed: TranscriptWord = {
        startMs: word.startMs,
        endMs: word.endMs,
        text: tokens[j],
        edited: true,
      }

      if (word.language) changed.language = word.language
      result[j] = changed
    }
  }

  // Unmatched runs between consecutive anchors (sentinels at both ends).
  const anchors: Array<[number, number]> = [[-1, -1], ...pairs, [old.length, tokens.length]]

  for (let index = 0; index < anchors.length - 1; index += 1) {
    const [prevOld, prevNew] = anchors[index]
    const [nextOld, nextNew] = anchors[index + 1]
    const runTokens = tokens.slice(prevNew + 1, nextNew)

    if (!runTokens.length) continue

    const prev = prevOld >= 0 ? old[prevOld] : undefined
    const next = nextOld < old.length ? old[nextOld] : undefined
    const nextStart = next ? next.startMs : hi
    const replaced = old.slice(prevOld + 1, nextOld)
    let start: number
    let end: number

    if (replaced.length) {
      start = replaced[0].startMs
      end = Math.max(start, Math.min(replaced[replaced.length - 1].endMs, nextStart))
    } else {
      const gapStart = prev ? prev.endMs : lo

      start = Math.min(gapStart, nextStart)
      end = nextStart
    }

    spread(runTokens, start, end).forEach((timing, offset) => {
      result[prevNew + 1 + offset] = editedWord(runTokens[offset], timing)
    })
  }

  return result.map((word) => {
    if (!word.edited || word.confidence === undefined) return word

    const { confidence, ...rest } = word

    void confidence
    return rest
  })
}

type Env = Record<string, string | undefined>

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** `MEETSUM_TRANSCRIPT_EDIT_MAX_CHARS` (default 5000). */
export function transcriptEditMaxChars(env: Env = process.env): number {
  return positiveIntegerEnv(env.MEETSUM_TRANSCRIPT_EDIT_MAX_CHARS, 5000)
}

/** `MEETSUM_TRANSCRIPT_REVISIONS_KEEP` revisions kept per segment (default 50). */
export function transcriptRevisionsKeep(env: Env = process.env): number {
  return positiveIntegerEnv(env.MEETSUM_TRANSCRIPT_REVISIONS_KEEP, 50)
}

/** Next free `Speaker N` label for a manually created speaker. */
export function nextSpeakerLabel(existingLabels: readonly string[]): string {
  let highest = 0

  for (const label of existingLabels) {
    const match = /^speaker\s+(\d+)$/i.exec(label.trim())

    if (match) highest = Math.max(highest, Number(match[1]))
  }

  return `Speaker ${Math.max(highest, existingLabels.length) + 1}`
}

/**
 * `replaceTranscript({preserveEdited})` (M4): every incoming segment that
 * matches a manually edited (`source='edited'`) segment — same id, else the
 * same start/end — keeps the edited row id, text, words, revision and edit
 * time; speaker and timing come from the incoming transcript. Each edited
 * segment is used at most once.
 */
export function preserveEditedSegments<T extends TranscriptSegment>(
  incoming: readonly T[],
  edited: readonly TranscriptSegment[]
): { segments: T[]; preservedIds: Set<string> } {
  const preservedIds = new Set<string>()

  if (!edited.length) return { segments: [...incoming], preservedIds }

  const byId = new Map(edited.map((segment) => [segment.id, segment]))
  const byBounds = new Map<string, TranscriptSegment>()
  const boundsKey = (segment: TranscriptSegment) =>
    `${Math.round(segment.startMs)}:${Math.round(segment.endMs)}`

  for (const segment of edited) {
    if (!byBounds.has(boundsKey(segment))) byBounds.set(boundsKey(segment), segment)
  }

  const segments = incoming.map((segment) => {
    const fromId = segment.id ? byId.get(segment.id) : undefined
    const match =
      fromId && !preservedIds.has(fromId.id) ? fromId : byBounds.get(boundsKey(segment))

    if (!match || preservedIds.has(match.id)) return segment

    preservedIds.add(match.id)

    const kept: T = {
      ...segment,
      id: match.id,
      text: match.text,
      source: "edited",
      revision: match.revision,
      editedAt: match.editedAt,
    }

    if (match.words) kept.words = match.words.map((word) => ({ ...word }))
    else delete kept.words
    return kept
  })

  return { segments, preservedIds }
}
