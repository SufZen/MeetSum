/**
 * Word-level timings stored in `transcript_segments.words` (jsonb, M3).
 *
 * Compact tuple format, one per word:
 *   [startMs, endMs, text, confidence | null]            same language as segment
 *   [startMs, endMs, text, confidence | null, language]  language differs
 *   [startMs, endMs, text, confidence | null, language | null, 1]
 *                                                        manually edited (M4)
 *
 * Times are integer milliseconds, confidence is rounded to 3 decimals. Words
 * carry no speaker: segments are speaker-homogeneous. This module is the only
 * place that knows the stored shape.
 */

export type TranscriptWord = {
  startMs: number
  endMs: number
  text: string
  confidence?: number
  /** Present only when it differs from the segment language. */
  language?: string
  /** Word created or changed by a manual transcript edit (M4). */
  edited?: boolean
}

export type EncodedTranscriptWord =
  | [number, number, string, number | null]
  | [number, number, string, number | null, string]
  | [number, number, string, number | null, string | null, 1]

function roundConfidence(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null

  return Math.round(value * 1000) / 1000
}

/** Encodes words for storage, dropping languages equal to the segment's. */
export function encodeWords(
  words: readonly TranscriptWord[],
  segmentLanguage?: string
): EncodedTranscriptWord[] {
  return words.map((word) => {
    const base: [number, number, string, number | null] = [
      Math.round(word.startMs),
      Math.round(word.endMs),
      word.text,
      roundConfidence(word.confidence),
    ]

    const language =
      word.language && word.language !== segmentLanguage ? word.language : undefined

    if (word.edited) return [...base, language ?? null, 1]

    return language ? [...base, language] : base
  })
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Decodes stored words. Accepts the parsed jsonb value or its JSON text;
 * anything that is not a list of well-formed tuples decodes to `[]`
 * (malformed entries are skipped).
 */
export function decodeWords(json: unknown): TranscriptWord[] {
  let value = json

  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }

  if (!Array.isArray(value)) return []

  const words: TranscriptWord[] = []

  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 3) continue

    const [startMs, endMs, text, confidence, language, edited] = entry as unknown[]

    if (!isFiniteNumber(startMs) || !isFiniteNumber(endMs) || typeof text !== "string") {
      continue
    }

    const word: TranscriptWord = { startMs, endMs, text }

    if (isFiniteNumber(confidence)) word.confidence = confidence
    if (typeof language === "string" && language) word.language = language
    if (edited === 1) word.edited = true
    words.push(word)
  }

  return words
}
