/**
 * Speaker lanes and talk-time stats (M4, client-safe, pure).
 */
import { segmentSpeakerKey } from "@/lib/player/transcript-search"
import type { MeetingSpeaker } from "@/lib/meetings/repository"

export type TimelineSegment = {
  startMs: number
  endMs: number
  speaker: string
  speakerId?: string
}

export type SpeakerRun = { startMs: number; endMs: number }

export type SpeakerLane = {
  /** `segmentSpeakerKey`: speaker id, else `label:<name>`. */
  key: string
  speakerId?: string
  label: string
  firstStartMs: number
  runs: SpeakerRun[]
  talkMs: number
}

export const DEFAULT_GAP_MERGE_MS = 1_500

/**
 * One lane per speaker, ordered by first speech. Consecutive runs of the same
 * speaker separated by ≤ gapMergeMs merge into one bar so the timeline stays
 * readable at a glance.
 */
export function buildSpeakerRuns(
  segments: readonly TimelineSegment[],
  speakers: readonly Pick<MeetingSpeaker, "id" | "label">[] = [],
  gapMergeMs: number = DEFAULT_GAP_MERGE_MS
): SpeakerLane[] {
  const lanes = new Map<string, SpeakerLane>()
  const byId = new Map(speakers.map((speaker) => [speaker.id, speaker]))
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs)

  for (const segment of sorted) {
    if (!(segment.endMs > segment.startMs)) continue

    const key = segmentSpeakerKey(segment)
    let lane = lanes.get(key)

    if (!lane) {
      const known = segment.speakerId ? byId.get(segment.speakerId) : undefined

      lane = {
        key,
        ...(segment.speakerId ? { speakerId: segment.speakerId } : {}),
        label: known?.label ?? segment.speaker,
        firstStartMs: segment.startMs,
        runs: [],
        talkMs: 0,
      }
      lanes.set(key, lane)
    }

    lane.talkMs += segment.endMs - segment.startMs

    const last = lane.runs.at(-1)

    if (last && segment.startMs - last.endMs <= gapMergeMs) {
      last.endMs = Math.max(last.endMs, segment.endMs)
    } else {
      lane.runs.push({ startMs: segment.startMs, endMs: segment.endMs })
    }
  }

  return [...lanes.values()].sort((a, b) => a.firstStartMs - b.firstStartMs)
}

/**
 * Longest uninterrupted stretch per speaker key: consecutive segments of the
 * same speaker (another speaker's segment breaks the monologue; silence
 * between the same speaker's segments does not).
 */
export function longestMonologueMs(segments: readonly TimelineSegment[]): Map<string, number> {
  const result = new Map<string, number>()
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs)
  let currentKey: string | undefined
  let currentStart = 0
  let currentEnd = 0

  const flush = () => {
    if (currentKey === undefined) return

    const length = currentEnd - currentStart

    if (length > (result.get(currentKey) ?? 0)) result.set(currentKey, length)
  }

  for (const segment of sorted) {
    const key = segmentSpeakerKey(segment)

    if (key === currentKey) {
      currentEnd = Math.max(currentEnd, segment.endMs)
      continue
    }

    flush()
    currentKey = key
    currentStart = segment.startMs
    currentEnd = segment.endMs
  }

  flush()

  return result
}

export type TalkTimeRow = {
  speakerId: string
  talkTimeMs: number
  /** Share of total talk time, 0..1. */
  share: number
  wordCount: number
  /** Words per minute of own talk time, undefined without words. */
  wpm?: number
  longestMonologueMs?: number
}

/**
 * Talk-time table from the stored speaker stats (`speakers.talk_time_ms`),
 * sorted by talk time; speakers who never spoke are hidden.
 */
export function buildTalkTimeRows(
  speakers: readonly Pick<MeetingSpeaker, "id" | "label" | "talkTimeMs" | "wordCount">[],
  segments: readonly TimelineSegment[] = []
): TalkTimeRow[] {
  const spoken = speakers.filter((speaker) => speaker.talkTimeMs > 0)
  const total = spoken.reduce((sum, speaker) => sum + speaker.talkTimeMs, 0)
  const monologues = longestMonologueMs(segments)

  return spoken
    .map((speaker) => {
      const minutes = speaker.talkTimeMs / 60_000
      const longest = monologues.get(speaker.id) ?? monologues.get(`label:${speaker.label}`)

      return {
        speakerId: speaker.id,
        talkTimeMs: speaker.talkTimeMs,
        share: total ? speaker.talkTimeMs / total : 0,
        wordCount: speaker.wordCount,
        ...(speaker.wordCount > 0 && minutes > 0
          ? { wpm: Math.round(speaker.wordCount / minutes) }
          : {}),
        ...(longest ? { longestMonologueMs: longest } : {}),
      }
    })
    .sort((a, b) => b.talkTimeMs - a.talkTimeMs)
}
