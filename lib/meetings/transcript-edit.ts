import type { TranscriptWord } from "@/lib/meetings/transcript-words"

export type SegmentBounds = { startMs: number; endMs: number }

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

/**
 * Re-times the words of an edited segment (M4).
 *
 * Step 0 stub: spreads the new tokens proportionally to their character
 * length over the segment bounds and marks every word edited. Package B
 * replaces it with LCS anchor alignment that keeps untouched timings.
 */
export function realignWords(
  oldWords: readonly TranscriptWord[] | undefined,
  newText: string,
  bounds: SegmentBounds
): TranscriptWord[] {
  void oldWords

  const tokens = tokenize(newText)

  if (!tokens.length) return []

  const start = Math.round(bounds.startMs)
  const span = Math.max(0, Math.round(bounds.endMs) - start)
  const weights = tokens.map((token) => Math.max(1, Array.from(token).length))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const words: TranscriptWord[] = []
  let cumulative = 0

  tokens.forEach((text, index) => {
    const wordStart = start + Math.round((span * cumulative) / total)

    cumulative += weights[index]

    const wordEnd = start + Math.round((span * cumulative) / total)

    words.push({ startMs: wordStart, endMs: wordEnd, text, edited: true })
  })

  return words
}
