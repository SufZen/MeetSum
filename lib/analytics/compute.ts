/**
 * Pure per-speaker talk analytics (M5 D1). Uses M3 raw words when every
 * segment has them (fillers survive there; segment text has them stripped by
 * transcript cleanup), otherwise segment text with `basis: "text"`.
 * Question and filler detection are heuristic (see questions.ts/fillers.ts).
 */
import { countFillers } from "@/lib/analytics/fillers"
import { countQuestions } from "@/lib/analytics/questions"
import { normalizeToken, tokenize } from "@/lib/analytics/text"
import type { MeetingAnalyticsMetrics, SpeakerAnalytics } from "@/lib/analytics/types"
import { sha1Hex } from "@/lib/intelligence/normalize"
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"

/** Same-speaker segments closer than this belong to one monologue. */
export const MONOLOGUE_GAP_MS = 1500
/** A speaker change closer than this (or overlapping) is an interruption. */
export const INTERRUPTION_GAP_MS = 200

/** Grouping key of a segment's speaker: the M3 speaker id, else the label. */
export function speakerKey(segment: Pick<TranscriptSegment, "speaker" | "speakerId">): string {
  return segment.speakerId ?? `label:${segment.speaker}`
}

function segmentTokens(segment: TranscriptSegment, useWords: boolean): string[] {
  if (useWords && segment.words?.length) {
    return segment.words.map((word) => normalizeToken(word.text)).filter(Boolean)
  }

  return tokenize(segment.text)
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits

  return Math.round(value * factor) / factor
}

function per100(count: number, words: number): number {
  return words > 0 ? round((count / words) * 100, 2) : 0
}

type Accumulator = {
  key: string
  speakerId?: string
  label: string
  displayName?: string
  talkTimeMs: number
  wordCount: number
  fillers: number
  questions: number
  interruptions: number
  longestMonologueMs: number
}

/**
 * Talk time, share, words, WPM, longest monologue, questions, filler rate and
 * interruptions per speaker (ordered by first speech), plus meeting totals.
 */
export function computeMeetingAnalytics(
  segments: TranscriptSegment[],
  speakers: MeetingSpeaker[]
): MeetingAnalyticsMetrics {
  const spoken = [...segments]
    .filter((segment) => segment.text.trim() || segment.words?.length)
    .sort((a, b) => a.startMs - b.startMs)
  const useWords = spoken.length > 0 && spoken.every((segment) => segment.words?.length)
  const speakersById = new Map(speakers.map((speaker) => [speaker.id, speaker]))
  const byKey = new Map<string, Accumulator>()
  const accumulator = (segment: TranscriptSegment) => {
    const key = speakerKey(segment)
    let entry = byKey.get(key)

    if (!entry) {
      const known = segment.speakerId ? speakersById.get(segment.speakerId) : undefined

      entry = {
        key,
        speakerId: segment.speakerId,
        label: known?.label ?? segment.speaker,
        displayName: known?.displayName,
        talkTimeMs: 0,
        wordCount: 0,
        fillers: 0,
        questions: 0,
        interruptions: 0,
        longestMonologueMs: 0,
      }
      byKey.set(key, entry)
    }

    return entry
  }

  let monologue: { key: string; startMs: number; endMs: number } | undefined
  let previous: TranscriptSegment | undefined
  const closeMonologue = () => {
    if (!monologue) return
    const entry = byKey.get(monologue.key)

    if (entry) {
      entry.longestMonologueMs = Math.max(entry.longestMonologueMs, monologue.endMs - monologue.startMs)
    }
  }

  for (const segment of spoken) {
    const entry = accumulator(segment)
    const tokens = segmentTokens(segment, useWords)

    entry.talkTimeMs += Math.max(0, segment.endMs - segment.startMs)
    entry.wordCount += tokens.length
    entry.fillers += countFillers(tokens)
    entry.questions += countQuestions(segment.text)

    if (previous && speakerKey(previous) !== entry.key) {
      if (segment.startMs - previous.endMs < INTERRUPTION_GAP_MS) entry.interruptions += 1
    }

    if (monologue && monologue.key === entry.key && segment.startMs - monologue.endMs < MONOLOGUE_GAP_MS) {
      monologue.endMs = Math.max(monologue.endMs, segment.endMs)
    } else {
      closeMonologue()
      monologue = { key: entry.key, startMs: segment.startMs, endMs: segment.endMs }
    }
    previous = segment
  }
  closeMonologue()

  const entries = [...byKey.values()]
  const totalTalkTimeMs = entries.reduce((sum, entry) => sum + entry.talkTimeMs, 0)
  const totalWords = entries.reduce((sum, entry) => sum + entry.wordCount, 0)
  const totalFillers = entries.reduce((sum, entry) => sum + entry.fillers, 0)
  const result: SpeakerAnalytics[] = entries.map((entry) => ({
    speakerId: entry.speakerId,
    label: entry.label,
    displayName: entry.displayName,
    talkTimeMs: entry.talkTimeMs,
    share: totalTalkTimeMs > 0 ? round(entry.talkTimeMs / totalTalkTimeMs, 4) : 0,
    wordCount: entry.wordCount,
    wpm: entry.talkTimeMs > 0 ? round(entry.wordCount / (entry.talkTimeMs / 60_000)) : 0,
    longestMonologueMs: entry.longestMonologueMs,
    questions: entry.questions,
    fillerPer100Words: per100(entry.fillers, entry.wordCount),
    interruptions: entry.interruptions,
  }))

  return {
    basis: useWords ? "words" : "text",
    totalTalkTimeMs,
    totalWords,
    totalQuestions: result.reduce((sum, entry) => sum + entry.questions, 0),
    fillerPer100Words: per100(totalFillers, totalWords),
    interruptions: result.reduce((sum, entry) => sum + entry.interruptions, 0),
    speakers: result,
  }
}

/**
 * Re-applies current speaker labels and display names (M3 rename) to stored
 * metrics without recomputing them.
 */
export function refreshSpeakerNames(
  metrics: MeetingAnalyticsMetrics,
  speakers: MeetingSpeaker[]
): MeetingAnalyticsMetrics {
  const byId = new Map(speakers.map((speaker) => [speaker.id, speaker]))

  return {
    ...metrics,
    speakers: metrics.speakers.map((entry) => {
      const known = entry.speakerId ? byId.get(entry.speakerId) : undefined

      return known ? { ...entry, label: known.label, displayName: known.displayName } : entry
    }),
  }
}

/** sha1 of segment ids, text and speaker ids, in transcript order. */
export function transcriptHash(segments: TranscriptSegment[]): string {
  const canonical = [...segments]
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
    .map((segment) => [segment.id, segment.text, segment.speakerId ?? segment.speaker])

  return sha1Hex(JSON.stringify(canonical))
}
