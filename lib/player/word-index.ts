/**
 * Time → segment / word lookup for the player (M4, client-safe, pure).
 *
 * Segments are sorted by start time. The index packs starts/ends into
 * Int32Arrays so a binary search over a 2-hour meeting (≈2k segments) or a
 * stress transcript (100k) stays allocation-free on every animation frame.
 */

export type TimedSpan = { startMs: number; endMs: number }

export type TranscriptIndex = {
  starts: Int32Array
  ends: Int32Array
  length: number
}

/** A word stays highlighted this long after its end (short pauses). */
export const WORD_TAIL_MS = 600

export function buildTranscriptIndex(segments: readonly TimedSpan[]): TranscriptIndex {
  const starts = new Int32Array(segments.length)
  const ends = new Int32Array(segments.length)

  for (let index = 0; index < segments.length; index += 1) {
    starts[index] = Math.round(segments[index].startMs)
    ends[index] = Math.round(segments[index].endMs)
  }

  return { starts, ends, length: segments.length }
}

/** Index of the last entry whose start is ≤ ms, or -1. */
function lastStartAtOrBefore(starts: ArrayLike<number>, length: number, ms: number): number {
  let low = 0
  let high = length - 1
  let found = -1

  while (low <= high) {
    const middle = (low + high) >>> 1

    if (starts[middle] <= ms) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return found
}

/**
 * The segment at `ms`: the last one starting at or before it. `inGap` is
 * true when `ms` is past that segment's end (silence) or before the first.
 */
export function findSegmentAt(
  index: TranscriptIndex,
  ms: number
): { index: number; inGap: boolean } {
  const found = lastStartAtOrBefore(index.starts, index.length, ms)

  if (found < 0) return { index: -1, inGap: true }

  return { index: found, inGap: ms >= index.ends[found] }
}

/**
 * The word at `ms`: last start ≤ ms while ms < end + WORD_TAIL_MS; else -1.
 */
export function findWordAt(words: readonly TimedSpan[], ms: number): number {
  let low = 0
  let high = words.length - 1
  let found = -1

  while (low <= high) {
    const middle = (low + high) >>> 1

    if (words[middle].startMs <= ms) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  if (found < 0) return -1

  return ms < words[found].endMs + WORD_TAIL_MS ? found : -1
}
