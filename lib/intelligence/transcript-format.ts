/**
 * Transcript serialization for prompts (A7): `[s12 03:41 דנה] text` lines
 * with short aliases mapped back to segment ids, M3 resolved speaker names,
 * a token estimate, and 30-minute windows for map-reduce.
 */
import { neutralizeData } from "@/lib/ai/prompts/data-block"
import type { MeetingSpeaker, TranscriptSegment } from "@/lib/meetings/repository"

export type PromptTranscript = {
  /** The transcript block (no ids other than the aliases). */
  text: string
  aliasToSegment: Map<string, TranscriptSegment>
  segmentToAlias: Map<string, string>
  segments: TranscriptSegment[]
  estimatedTokens: number
}

export const MAP_REDUCE_WINDOW_MS = 30 * 60 * 1000

/** `mm:ss`, or `h:mm:ss` from one hour. */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`

  return hours ? `${hours}:${mmss}` : mmss
}

/**
 * Rough token estimate. Hebrew tokenizes denser than English, so 3 chars per
 * token is used as a conservative average for mixed transcripts.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

function speakerName(segment: TranscriptSegment, speakers: Map<string, MeetingSpeaker>): string {
  const speaker = segment.speakerId ? speakers.get(segment.speakerId) : undefined
  const name = speaker?.displayName?.trim() || segment.speaker?.trim() || speaker?.label

  return neutralizeData((name || "?").replace(/[[\]]/g, ""))
}

/**
 * Formats segments (in time order) for a prompt. Aliases are `s1..sN` over
 * the given segments; pass the full transcript's `segmentToAlias` as
 * `aliases` to keep aliases stable across map-reduce windows.
 */
export function formatTranscriptForPrompt(
  segments: readonly TranscriptSegment[],
  speakers: readonly MeetingSpeaker[] = [],
  options: { aliases?: Map<string, string> } = {}
): PromptTranscript {
  const speakerById = new Map(speakers.map((speaker) => [speaker.id, speaker]))
  const ordered = [...segments].sort((left, right) => left.startMs - right.startMs)
  const aliasToSegment = new Map<string, TranscriptSegment>()
  const segmentToAlias = new Map<string, string>()
  const lines: string[] = []

  ordered.forEach((segment, index) => {
    const alias = options.aliases?.get(segment.id) ?? `s${index + 1}`
    // Segment text is data: `<` is neutralized so `</transcript>` can't close the block.
    const text = neutralizeData(segment.text.replace(/\s+/g, " ").trim())

    aliasToSegment.set(alias, segment)
    segmentToAlias.set(segment.id, alias)
    if (text) {
      lines.push(`[${alias} ${formatTimestamp(segment.startMs)} ${speakerName(segment, speakerById)}] ${text}`)
    }
  })

  const text = lines.join("\n")

  return { text, aliasToSegment, segmentToAlias, segments: ordered, estimatedTokens: estimateTokens(text) }
}

/** Splits segments into consecutive windows by start time. */
export function windowSegments(
  segments: readonly TranscriptSegment[],
  windowMs = MAP_REDUCE_WINDOW_MS
): TranscriptSegment[][] {
  const ordered = [...segments].sort((left, right) => left.startMs - right.startMs)
  const windows: TranscriptSegment[][] = []
  const first = ordered[0]?.startMs ?? 0

  for (const segment of ordered) {
    const index = Math.floor((segment.startMs - first) / windowMs)

    ;(windows[index] ??= []).push(segment)
  }

  return windows.filter((window) => window?.length)
}

/** Transcript end: the latest segment end (or start). */
export function transcriptEndMs(segments: readonly TranscriptSegment[]): number {
  return segments.reduce((max, segment) => Math.max(max, segment.endMs ?? segment.startMs), 0)
}
