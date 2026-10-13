import type {
  SpeakerMappingStatus,
  TranscriptSegment,
  TranscriptSpeakerInput,
} from "@/lib/meetings/repository"
import {
  computeTurnIndexes,
  reconcileSpeakerInputs,
  summarizeSpeakerStats,
} from "@/lib/meetings/speakers/stats"

/** The parts of a stored `speakers` row that `replaceTranscript` reasons about. */
export type ExistingSpeakerRow = {
  id: string
  label: string
  source: string
  mappingStatus: SpeakerMappingStatus
  /** Name shown for the speaker (participant name, display name or label). */
  resolvedName?: string
}

export type SpeakerUpsert = {
  id: string
  /** False when an existing row (same meeting + label) is updated. */
  isNew: boolean
  label: string
  source: string
  talkTimeMs: number
  wordCount: number
  segmentCount: number
  firstStartMs?: number
  embedding?: number[]
  embeddingModel?: string
  /**
   * True when the mapping (participant, profile, display name, suggestion,
   * status) must be reset to `unmapped`. A confirmed/rejected mapping survives
   * only when the label survives with an unchanged source whose labels are
   * identities (a Meet re-import); diarized `asr` labels are arbitrary per
   * run, so re-ASR resets them — unless the same transcript is re-written
   * (`preserveDiarizedMappings`, legacy cleanup path).
   */
  resetMapping: boolean
}

export type TranscriptReplacementPlan = {
  upserts: SpeakerUpsert[]
  /** Existing speaker rows that no longer have segments. */
  deleteIds: string[]
  /** Segments to insert, with speaker ids and turn indexes. */
  segments: Array<TranscriptSegment & { speakerId: string; turnIndex: number; source: string }>
}

const KEPT_STATUSES: ReadonlySet<SpeakerMappingStatus> = new Set(["confirmed", "rejected"])

/** Sources whose speaker labels are arbitrary per run (diarization). */
const DIARIZED_SOURCES: ReadonlySet<string> = new Set(["asr"])

function keepsMapping(
  existing: ExistingSpeakerRow,
  source: string,
  preserveDiarizedMappings: boolean
): boolean {
  if (!KEPT_STATUSES.has(existing.mappingStatus) || existing.source !== source) return false

  return preserveDiarizedMappings || !DIARIZED_SOURCES.has(source)
}

/**
 * Plans a transcript replacement: one speaker row per label that still has
 * segments (upserted on meeting + label), deletion of speakers left without
 * segments, and segments pointing at their speaker row.
 */
export function planTranscriptReplacement(options: {
  existing: readonly ExistingSpeakerRow[]
  segments: readonly TranscriptSegment[]
  speakers: readonly TranscriptSpeakerInput[]
  createId: (prefix: string) => string
  /** Same transcript re-written: keep diarized confirmed/rejected mappings. */
  preserveDiarizedMappings?: boolean
}): TranscriptReplacementPlan {
  const byLabel = new Map<string, ExistingSpeakerRow>()

  for (const row of options.existing) {
    if (!byLabel.has(row.label)) byLabel.set(row.label, row)
  }

  const upserts: SpeakerUpsert[] = reconcileSpeakerInputs(
    options.segments,
    options.speakers
  ).map((stats) => {
    const source = stats.source ?? "asr"
    const existing = byLabel.get(stats.label)

    return {
      id: existing?.id ?? options.createId("speaker"),
      isNew: !existing,
      label: stats.label,
      source,
      talkTimeMs: Math.round(stats.talkTimeMs),
      wordCount: stats.wordCount,
      segmentCount: stats.segmentCount,
      firstStartMs:
        stats.firstStartMs === undefined ? undefined : Math.round(stats.firstStartMs),
      embedding: stats.embedding,
      embeddingModel: stats.embeddingModel,
      resetMapping: existing
        ? !keepsMapping(existing, source, options.preserveDiarizedMappings ?? false)
        : false,
    }
  })
  const idByLabel = new Map(upserts.map((upsert) => [upsert.label, upsert.id]))
  const keptIds = new Set(upserts.map((upsert) => upsert.id))
  const needsTurns = options.segments.some((segment) => segment.turnIndex === undefined)
  const turns = needsTurns
    ? computeTurnIndexes(options.segments, (segment) => segment.speaker)
    : options.segments.map((segment) => segment.turnIndex ?? 0)
  const segments = options.segments
    .map((segment, index) => ({
      ...segment,
      id: segment.id || options.createId("seg"),
      speakerId: idByLabel.get(segment.speaker) as string,
      turnIndex: turns[index],
      source: segment.source ?? "asr",
    }))
    .sort((a, b) => a.startMs - b.startMs)

  return {
    upserts,
    deleteIds: options.existing.map((row) => row.id).filter((id) => !keptIds.has(id)),
    segments,
  }
}

/**
 * Legacy `replaceTranscriptSegments` input → `replaceTranscript` input.
 * Segments read back from a meeting carry `speakerId` and the resolved name;
 * those keep their speaker's label (and source, so confirmed mappings
 * survive). A segment whose speaker text was changed (legacy rename) or that
 * has no known speaker is keyed by its speaker text.
 */
export function legacySegmentsToTranscript(
  existing: readonly ExistingSpeakerRow[],
  segments: readonly TranscriptSegment[]
): { segments: TranscriptSegment[]; speakers: TranscriptSpeakerInput[] } {
  const byId = new Map(existing.map((row) => [row.id, row]))
  const sourceByLabel = new Map<string, string>()

  for (const row of existing) {
    if (!sourceByLabel.has(row.label)) sourceByLabel.set(row.label, row.source)
  }

  const labeled = segments.map((segment) => {
    const { speakerId, ...rest } = segment
    const row = speakerId ? byId.get(speakerId) : undefined

    if (row && (segment.speaker === row.label || segment.speaker === row.resolvedName)) {
      return { ...rest, speaker: row.label }
    }

    return rest
  })
  const speakers = summarizeSpeakerStats(labeled).map((stats) => ({
    ...stats,
    source:
      sourceByLabel.get(stats.label) ??
      labeled.find((segment) => segment.speaker === stats.label)?.source ??
      "asr",
  }))

  return { segments: labeled, speakers }
}
