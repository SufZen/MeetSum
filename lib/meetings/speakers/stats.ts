import type {
  TranscriptSegment,
  TranscriptSpeakerInput,
} from "@/lib/meetings/repository"

/** Words of a segment: its word timings when present, else its text tokens. */
export function segmentWordCount(segment: Pick<TranscriptSegment, "text" | "words">): number {
  if (segment.words?.length) return segment.words.length

  return segment.text.split(/\s+/u).filter(Boolean).length
}

/**
 * Turn index of every segment, in start order: increments on every speaker
 * change. Keyed by the segment's speaker key (speaker id, else label).
 */
export function computeTurnIndexes<T extends { startMs: number }>(
  segments: readonly T[],
  speakerKey: (segment: T) => string
): number[] {
  const order = segments
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) => a.segment.startMs - b.segment.startMs || a.index - b.index)
  const turns = new Array<number>(segments.length)
  let turn = -1
  let previous: string | undefined

  for (const { segment, index } of order) {
    const key = speakerKey(segment)

    if (key !== previous) {
      turn += 1
      previous = key
    }
    turns[index] = turn
  }

  return turns
}

/** Per-label talk time / word / segment stats derived from segments. */
export function summarizeSpeakerStats(
  segments: readonly TranscriptSegment[],
  source?: string
): TranscriptSpeakerInput[] {
  const stats = new Map<string, TranscriptSpeakerInput>()

  for (const segment of segments) {
    const current = stats.get(segment.speaker) ?? {
      label: segment.speaker,
      source,
      talkTimeMs: 0,
      wordCount: 0,
      segmentCount: 0,
      firstStartMs: segment.startMs,
    }

    current.talkTimeMs += Math.max(0, segment.endMs - segment.startMs)
    current.wordCount += segmentWordCount(segment)
    current.segmentCount += 1
    current.firstStartMs = Math.min(current.firstStartMs ?? segment.startMs, segment.startMs)
    stats.set(segment.speaker, current)
  }

  return [...stats.values()].sort(
    (a, b) => (a.firstStartMs ?? 0) - (b.firstStartMs ?? 0)
  )
}

/**
 * Stats for the labels that still have segments: provided stats win, labels
 * without provided stats get derived ones, labels without segments are dropped
 * (a speaker without segments is deleted).
 */
export function reconcileSpeakerInputs(
  segments: readonly TranscriptSegment[],
  speakers: readonly TranscriptSpeakerInput[]
): TranscriptSpeakerInput[] {
  const derived = summarizeSpeakerStats(segments)
  const provided = new Map(speakers.map((speaker) => [speaker.label, speaker]))

  return derived.map((stats) => {
    const given = provided.get(stats.label)

    return given ? { ...given, firstStartMs: given.firstStartMs ?? stats.firstStartMs } : stats
  })
}

/** Running mean of two embeddings: `previous` weighs `samples`. */
export function runningMeanEmbedding(
  previous: readonly number[],
  samples: number,
  next: readonly number[]
): number[] {
  if (previous.length !== next.length || samples <= 0) return [...next]

  return previous.map((value, index) => (value * samples + next[index]) / (samples + 1))
}

/** Case-insensitive, whitespace-normalized union of alias lists. */
export function unionAliases(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const list of lists) {
    for (const raw of list) {
      const alias = raw.normalize("NFC").trim().replace(/\s+/gu, " ")
      const key = alias.toLocaleLowerCase()

      if (!alias || seen.has(key)) continue
      seen.add(key)
      result.push(alias)
    }
  }

  return result
}

/** Profile name key: NFC, trimmed, whitespace-collapsed, lowercase. */
export function normalizeProfileName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase()
}
