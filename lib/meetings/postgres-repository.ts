import { createHash } from "node:crypto"
import type { Queryable } from "@/lib/db/client"
import type {
  ActionItem,
  CreateContextInput,
  CreateMeetingInput,
  DeletedMeeting,
  ExportRecord,
  GetMeetingOptions,
  JobRecord,
  JobStatus,
  MediaAsset,
  MeetArtifact,
  MeetConferenceRecord,
  AiRunRecord,
  MeetingAnswer,
  MeetingContext,
  MeetingListItem,
  MeetingListOptions,
  MeetingListPage,
  MeetingListSortMode,
  MeetingTranscript,
  MeetingParticipant,
  MeetingRecord,
  MeetingRepository,
  GetShareMediaByToken,
  MeetingShare,
  MeetingTitleSource,
  MeetingVisibility,
  RepoScope,
  ReplaceTranscriptInput,
  SpeakerMappingStatus,
  SpeakerProfile,
  SpeakerSuggestion,
  SuggestedAgentRun,
  MeetingSpeaker,
  SegmentMutationResult,
  TranscriptRevision,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import {
  MeetingExternalIdConflictError,
  MeetingScopeError,
  NothingToUndoError,
  SegmentNotFoundError,
  TranscriptConflictError,
  TranscriptSpeakerNotFoundError,
} from "@/lib/meetings/repository"
import {
  computeTurnIndexes,
  normalizeProfileName,
  runningMeanEmbedding,
  unionAliases,
} from "@/lib/meetings/speakers/stats"
import {
  legacySegmentsToTranscript,
  planTranscriptReplacement,
  type ExistingSpeakerRow,
} from "@/lib/meetings/speakers/transcript-plan"
import {
  nextSpeakerLabel,
  preserveEditedSegments,
  realignWords,
  transcriptRevisionsKeep,
} from "@/lib/meetings/transcript-edit"
import { decodeWords, encodeWords } from "@/lib/meetings/transcript-words"
import { meetingScopeSql } from "@/lib/meetings/visibility"
import { DEFAULT_SHARE_SECTIONS } from "@/lib/sharing/share-sections"
import { mergeActionItems } from "@/lib/meetings/action-item-merge"
import { getMeetingDurationMs } from "@/lib/meetings/duration"
import { dueDateFromDueOn, parseDueDate } from "@/lib/tasks/due-date"
import {
  hasOwnerPatch,
  isContentPatch,
  isDateOnly,
  ownerTextOf,
  resolveDuePatch,
} from "@/lib/tasks/patch"
import { getTaskTimeZone } from "@/lib/tasks/time-zone"
import {
  deriveMeetingQualityWarnings,
  type TranscriptQualityStats,
} from "@/lib/meetings/quality"
import {
  buildMeetingIntelligence,
  type MeetingIntelligence,
  type MeetingTag,
} from "@/lib/intelligence"
import type { MeetingStatus } from "@/lib/meetings/state"

type MeetingRow = {
  id: string
  title: string
  source: MeetingRecord["source"]
  language: string
  status: MeetingRecord["status"]
  retention: MeetingRecord["retention"]
  started_at: string | Date
  participants: string[] | string
  language_metadata?: MeetingRecord["languageMetadata"]
  external_source?: string | null
  external_id?: string | null
  workspace_id?: string | null
  owner_user_id?: string | null
  visibility?: MeetingVisibility | null
  /** M4 (021). */
  duration_ms?: number | null
  transcript_version?: number | null
  /** M5 (022). */
  template_key?: string | null
  title_source?: MeetingTitleSource | null
}

type TranscriptRow = {
  id: string
  speaker_id?: string | null
  speaker_label: string | null
  start_ms: number
  end_ms: number
  text: string
  confidence: string | number | null
  language: string | null
  words?: unknown
  turn_index?: number | null
  source?: string | null
  /** M4 (021). */
  revision?: number | string | null
  edited_at?: string | Date | null
}

type SegmentStatsRow = {
  segment_count: number | string | null
  edited_count: number | string | null
  edited_at: string | Date | null
  average_confidence: number | string | null
  max_end_ms: number | string | null
  all_smart_notes: boolean | null
  all_generic: boolean | null
}

type RevisionRow = {
  id: string
  meeting_id: string
  segment_id: string
  revision: number | string
  text: string
  words: unknown
  speaker_id: string | null
  source: string
  created_by_user_id: string | null
  created_at: string | Date
  reverted_at: string | Date | null
}

type SpeakerRow = {
  id: string
  meeting_id: string
  label: string
  display_name: string | null
  participant_name: string | null
  participant_id: string | null
  profile_id: string | null
  mapping_status: SpeakerMappingStatus
  suggestion: SpeakerSuggestion | null
  source: string
  talk_time_ms: number | string | null
  word_count: number | string | null
  segment_count: number | string | null
  first_start_ms: number | null
  confirmed_at: string | Date | null
  embedding?: number[] | null
  embedding_model?: string | null
}

type SpeakerProfileRow = {
  id: string
  workspace_id: string
  display_name: string
  email: string | null
  aliases: string[] | null
  confirmed_count: number | string
  voice_embedding: number[] | null
  embedding_model: string | null
  embedding_samples: number | string | null
}

type SummaryRow = {
  id: string
  overview: string
  language: string
  model_provider: string | null
}

type SummarySectionRow = {
  kind: string
  content: unknown
}

type ActionItemRow = {
  id: string
  title: string
  owner: string | null
  status: ActionItem["status"]
  due_date: string | Date | null
  priority: ActionItem["priority"]
  confidence: string | number | null
  source_quote: string | null
  source_start_ms: number | null
  kind: ActionItem["kind"]
  edited_by_user?: boolean | null
  origin?: ActionItem["origin"] | null
  original_title?: string | null
  completed_at?: string | Date | null
  /** M5 (022). */
  workspace_id?: string | null
  meeting_id?: string | null
  owner_text?: string | null
  owner_participant_id?: string | null
  owner_speaker_id?: string | null
  owner_user_id?: string | null
  due_on?: string | Date | null
  due_text?: string | null
  due_source?: ActionItem["dueSource"] | null
  source_segment_id?: string | null
  created_by_user_id?: string | null
  created_at?: string | Date | null
}

type TagRow = { name: MeetingTag }
type IntelligenceRunRow = { output: MeetingIntelligence }

type ContextRow = {
  id: string
  name: string
  description: string | null
  color?: string | null
  kind?: MeetingContext["kind"] | null
  created_at: string | Date
}

type ParticipantRow = {
  id: string
  meeting_id: string
  name: string
  email: string | null
  role: MeetingParticipant["role"]
  source: MeetingParticipant["source"]
  attendance_status: MeetingParticipant["attendanceStatus"]
  speaker_label: string | null
  confidence: string | number | null
  created_at: string | Date
  updated_at: string | Date
}

type MeetingShareRow = {
  id: string
  meeting_id: string
  token: string
  visibility: MeetingShare["visibility"]
  revoked: boolean
  expires_at: string | Date | null
  included_sections: string[] | string
  created_by: string | null
  created_at: string | Date
  updated_at: string | Date
  /** M5 (022). */
  scope?: MeetingShare["scope"] | null
  clip_id?: string | null
}

type ExportRecordRow = {
  id: string
  meeting_id: string
  format: ExportRecord["format"]
  status: ExportRecord["status"]
  metadata: Record<string, unknown> | null
  created_at: string | Date
}

type SuggestedAgentRunRow = {
  id: string
  meeting_id: string
  target: SuggestedAgentRun["target"]
  payload: Record<string, unknown> | null
  response: Record<string, unknown> | null
  status: SuggestedAgentRun["status"]
  last_error: string | null
  created_at: string | Date
}

type MediaAssetRow = {
  id: string
  meeting_id: string
  storage_key: string
  filename: string | null
  content_type: string
  size_bytes: string | number
  retention: MediaAsset["retention"]
  source: string | null
  source_file_id: string | null
  checksum_sha256: string | null
  metadata?: Record<string, unknown> | null
  /** M4 (021). */
  kind?: MediaAsset["kind"] | null
  derived_from_asset_id?: string | null
  duration_ms?: number | null
  peaks_storage_key?: string | null
  prepared_at?: string | Date | null
  prepare_error?: string | null
  created_at: string | Date
}

type MeetArtifactRow = {
  conference_record_id: string
  conference_record_name: string
  meeting_id: string | null
  calendar_event_id: string | null
  space_name: string | null
  conference_start_time: string | Date | null
  conference_end_time: string | Date | null
  expire_time: string | Date | null
  artifact_id: string | null
  artifact_type: MeetArtifact["artifactType"] | null
  artifact_name: string | null
  state: string | null
  drive_file_id: string | null
  drive_file_name: string | null
  document_name: string | null
  artifact_start_time: string | Date | null
  artifact_end_time: string | Date | null
}

type JobRow = {
  id: string
  name: string
  status: JobStatus
  meeting_id: string | null
  payload: Record<string, unknown> | null
  result: Record<string, unknown> | null
  error: string | null
  attempts: number
  max_attempts: number
  retry_of_job_id: string | null
  started_at: string | Date | null
  completed_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

type AiRunRow = {
  id: string
  meeting_id: string
  provider: string
  task: string
  status: AiRunRecord["status"]
  metadata: Record<string, unknown> | null
  model: string | null
  latency_ms: number | null
  confidence: string | number | null
  started_at: string | Date
  completed_at: string | Date | null
  error: string | null
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/**
 * Coerce an action-item due date to a value the timestamptz column accepts.
 * The summary model sometimes emits non-date phrases ("Friday", Hebrew relative
 * dates like "לפני שבוע"); those are dropped to null rather than crashing the
 * whole intelligence write with an invalid-timestamp error.
 */
function coerceDueDate(value?: string | null): string | null {
  if (!value) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function normalizeLimit(value?: number) {
  if (!value || !Number.isFinite(value)) return 50

  return Math.max(1, Math.min(Math.trunc(value), 100))
}

function normalizeOffset(value?: number) {
  if (!value || !Number.isFinite(value)) return 0

  return Math.max(0, Math.trunc(value))
}

function normalizeSort(value?: MeetingListSortMode): MeetingListSortMode {
  if (
    value === "recent" ||
    value === "oldest" ||
    value === "title" ||
    value === "status"
  ) {
    return value
  }

  return "smart"
}

/**
 * WHERE clause of meeting lists. The scope predicate is always the first
 * clause, so no list query can ever run without it.
 */
function buildMeetingListClauses(scope: RepoScope, options: MeetingListOptions) {
  const values: unknown[] = []
  const clauses: string[] = [meetingScopeSql(scope, "m", values)]

  if (options.status && options.status !== "all") {
    if (options.status === "usable") {
      clauses.push(
        `m.status in ('completed', 'indexing', 'summarizing', 'transcribing', 'media_uploaded', 'failed')`
      )
    } else if (options.status === "upcoming") {
      clauses.push(`m.status = 'scheduled' and m.started_at > now()`)
    } else if (options.status === "processing") {
      clauses.push(
        `m.status in ('indexing', 'summarizing', 'transcribing', 'media_uploaded')`
      )
    } else if (options.status === "favorites") {
      // Favorites are per user; API keys and system scope have none.
      if (scope.kind === "member") {
        values.push(scope.userId)
        clauses.push(
          `exists (select 1 from meeting_favorites mf where mf.meeting_id = m.id and mf.user_id = $${values.length})`
        )
      } else {
        clauses.push("false")
      }
    } else {
      values.push(options.status)
      clauses.push(`m.status = $${values.length}`)
    }
  }

  if (options.query?.trim()) {
    values.push(`%${options.query.trim()}%`)
    const queryIndex = values.length

    clauses.push(`
      (
        m.title ilike $${queryIndex}
        or m.source::text ilike $${queryIndex}
        or m.language ilike $${queryIndex}
        or exists (
          select 1 from transcript_segments ts
          where ts.meeting_id = m.id and ts.text ilike $${queryIndex}
        )
        or exists (
          select 1 from summaries s
          where s.meeting_id = m.id and s.overview ilike $${queryIndex}
        )
        or exists (
          select 1 from action_items ai
          where ai.meeting_id = m.id and ai.title ilike $${queryIndex}
        )
        or exists (
          select 1
          from meeting_tags mt
          join tags t on t.id = mt.tag_id
          where mt.meeting_id = m.id and t.workspace_id = m.workspace_id
            and t.name ilike $${queryIndex}
        )
      )
    `)
  }

  return {
    whereSql: `where ${clauses.join(" and ")}`,
    values,
  }
}

function meetingOrderSql(sort: MeetingListSortMode) {
  if (sort === "recent") return `m.started_at desc, m.created_at desc`
  if (sort === "oldest") return `m.started_at asc, m.created_at asc`
  if (sort === "title") return `lower(m.title) asc, m.started_at desc`
  if (sort === "status") return `m.status asc, m.started_at desc`

  return `
    case
      when m.status in ('completed', 'indexing', 'summarizing', 'transcribing', 'media_uploaded', 'failed') then 0
      when m.status = 'scheduled' and m.started_at > now() then 2
      else 1
    end asc,
    coalesce(recent_job.last_job_at, recent_import.imported_at, m.created_at, m.started_at) desc,
    m.started_at desc
  `
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }

  return []
}

function mapMeetingRow(row: MeetingRow): MeetingRecord {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    language: row.language,
    status: row.status,
    retention: row.retention,
    startedAt: toIso(row.started_at),
    participants: parseJsonArray(row.participants),
    isFavorite: false,
    languageMetadata: row.language_metadata,
    externalSource: row.external_source ?? undefined,
    externalId: row.external_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    ownerUserId: row.owner_user_id ?? undefined,
    visibility: row.visibility ?? undefined,
    ...(typeof row.duration_ms === "number" ? { durationMs: row.duration_ms } : {}),
    ...(row.transcript_version !== undefined && row.transcript_version !== null
      ? { transcriptVersion: Number(row.transcript_version) }
      : {}),
    ...(row.template_key ? { templateKey: row.template_key } : {}),
    ...(row.title_source ? { titleSource: row.title_source } : {}),
  }
}

function mapParticipant(row: ParticipantRow): MeetingParticipant {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    name: row.name,
    email: row.email ?? undefined,
    role: row.role,
    source: row.source,
    attendanceStatus: row.attendance_status,
    speakerLabel: row.speaker_label ?? undefined,
    confidence: row.confidence === null ? undefined : Number(row.confidence),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapMeetingShare(row: MeetingShareRow): MeetingShare {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    token: row.token,
    visibility: row.visibility,
    revoked: row.revoked,
    expiresAt: row.expires_at ? toIso(row.expires_at) : undefined,
    includedSections: parseJsonArray(row.included_sections),
    createdBy: row.created_by ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    scope: row.scope ?? "meeting",
    clipId: row.clip_id ?? undefined,
  }
}

function mapExportRecord(row: ExportRecordRow): ExportRecord {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    format: row.format,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: toIso(row.created_at),
  }
}

function mapActionItem(row: ActionItemRow): ActionItem {
  return {
    id: row.id,
    title: row.title,
    owner: row.owner ?? undefined,
    status: row.status,
    dueDate: row.due_date ? toIso(row.due_date) : undefined,
    priority: row.priority,
    confidence:
      row.confidence === null ? undefined : Number(row.confidence),
    sourceQuote: row.source_quote ?? undefined,
    sourceStartMs: row.source_start_ms ?? undefined,
    kind: row.kind,
    editedByUser: row.edited_by_user ?? false,
    origin: row.origin ?? "ai",
    originalTitle: row.original_title ?? undefined,
    completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
    ownerText: row.owner_text ?? undefined,
    ownerParticipantId: row.owner_participant_id ?? undefined,
    ownerSpeakerId: row.owner_speaker_id ?? undefined,
    ownerUserId: row.owner_user_id ?? undefined,
    dueOn: row.due_on ? toDateOnly(row.due_on) : undefined,
    dueText: row.due_text ?? undefined,
    dueSource: row.due_source ?? undefined,
    sourceSegmentId: row.source_segment_id ?? undefined,
    meetingId: row.meeting_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at ? toIso(row.created_at) : undefined,
  }
}

/** Maps an `action_items` row selected with `actionItemColumns` (tasks store). */
export function mapTaskActionItemRow(row: Record<string, unknown>): ActionItem {
  return mapActionItem(row as unknown as ActionItemRow)
}

/** `date` columns: node-postgres returns a local-midnight Date. */
function toDateOnly(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10)

  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, "0")
  const day = String(value.getDate()).padStart(2, "0")

  return `${year}-${month}-${day}`
}

function mapMediaAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    storageKey: row.storage_key,
    filename: row.filename ?? undefined,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    retention: row.retention,
    source: row.source ?? undefined,
    sourceFileId: row.source_file_id ?? undefined,
    checksumSha256: row.checksum_sha256 ?? undefined,
    metadata: row.metadata ?? undefined,
    kind: row.kind ?? "original",
    derivedFromAssetId: row.derived_from_asset_id ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    peaksStorageKey: row.peaks_storage_key ?? undefined,
    preparedAt: row.prepared_at ? toIso(row.prepared_at) : undefined,
    prepareError: row.prepare_error ?? undefined,
    createdAt: toIso(row.created_at),
  }
}

/** List-item media asset: no metadata (M4 lightweight list). */
function mapListMediaAsset(row: MediaAssetRow): MediaAsset {
  const { metadata, ...asset } = mapMediaAsset(row)

  void metadata
  return asset
}

function mapRevision(row: RevisionRow): TranscriptRevision {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    segmentId: row.segment_id,
    revision: Number(row.revision),
    text: row.text,
    ...(row.words !== null && row.words !== undefined ? { words: decodeWords(row.words) } : {}),
    speakerId: row.speaker_id ?? undefined,
    source: row.source,
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: toIso(row.created_at),
    revertedAt: row.reverted_at ? toIso(row.reverted_at) : undefined,
  }
}

function mapSegmentStats(row: SegmentStatsRow | undefined): TranscriptQualityStats & {
  editedCount: number
  editedAt?: string
  maxEndMs?: number
} {
  return {
    segmentCount: optionalNumber(row?.segment_count) ?? 0,
    averageConfidence: optionalNumber(row?.average_confidence),
    allSmartNotesSpeakers: row?.all_smart_notes === true,
    allGenericSpeakers: row?.all_generic === true,
    editedCount: optionalNumber(row?.edited_count) ?? 0,
    editedAt: row?.edited_at ? toIso(row.edited_at) : undefined,
    maxEndMs: optionalNumber(row?.max_end_ms),
  }
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    meetingId: row.meeting_id ?? undefined,
    payload: row.payload ?? {},
    result: row.result ?? {},
    error: row.error ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    retryOfJobId: row.retry_of_job_id ?? undefined,
    startedAt: row.started_at ? toIso(row.started_at) : undefined,
    completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
    retryable: row.status === "failed" && row.attempts < row.max_attempts,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapAiRun(row: AiRunRow): AiRunRecord {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    provider: row.provider,
    task: row.task,
    status: row.status,
    metadata: row.metadata ?? {},
    model: row.model ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    confidence: row.confidence === null ? undefined : Number(row.confidence),
    startedAt: toIso(row.started_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
    error: row.error ?? undefined,
  }
}

function optionalNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function mapSpeaker(row: SpeakerRow, includeEmbeddings = false): MeetingSpeaker {
  const speaker: MeetingSpeaker = {
    id: row.id,
    meetingId: row.meeting_id,
    label: row.label,
    displayName: row.participant_name ?? row.display_name ?? undefined,
    participantId: row.participant_id ?? undefined,
    profileId: row.profile_id ?? undefined,
    mappingStatus: row.mapping_status,
    suggestion: row.suggestion ?? undefined,
    source: row.source,
    talkTimeMs: optionalNumber(row.talk_time_ms) ?? 0,
    wordCount: optionalNumber(row.word_count) ?? 0,
    segmentCount: optionalNumber(row.segment_count) ?? 0,
    firstStartMs: row.first_start_ms ?? undefined,
    confirmedAt: row.confirmed_at ? toIso(row.confirmed_at) : undefined,
  }

  if (includeEmbeddings && row.embedding?.length) {
    speaker.embedding = row.embedding.map(Number)
    speaker.embeddingModel = row.embedding_model ?? undefined
  }
  return speaker
}

function mapSpeakerProfile(row: SpeakerProfileRow): SpeakerProfile {
  const profile: SpeakerProfile = {
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    email: row.email ?? undefined,
    aliases: row.aliases ?? [],
    confirmedCount: optionalNumber(row.confirmed_count) ?? 0,
  }

  if (row.voice_embedding?.length) {
    profile.voiceEmbedding = row.voice_embedding.map(Number)
    profile.embeddingModel = row.embedding_model ?? undefined
  }
  return profile
}

function mapTranscriptRow(segment: TranscriptRow): TranscriptSegment {
  const mapped: TranscriptSegment = {
    id: segment.id,
    speaker: segment.speaker_label ?? "Speaker",
    startMs: segment.start_ms,
    endMs: segment.end_ms,
    text: segment.text,
    confidence: segment.confidence === null ? undefined : Number(segment.confidence),
    language: segment.language ?? undefined,
  }

  if (segment.speaker_id) mapped.speakerId = segment.speaker_id
  if (segment.words !== null && segment.words !== undefined) {
    mapped.words = decodeWords(segment.words)
  }
  if (typeof segment.turn_index === "number") mapped.turnIndex = segment.turn_index
  if (segment.source) mapped.source = segment.source
  if (segment.revision !== undefined && segment.revision !== null) {
    mapped.revision = Number(segment.revision)
  }
  if (segment.edited_at) mapped.editedAt = toIso(segment.edited_at)
  return mapped
}

/** Segments with resolved speaker names (`ts` + speaker `s` + participant `p`). */
const TRANSCRIPT_SELECT = `
  select
    ts.id,
    ts.speaker_id,
    coalesce(p.name, s.display_name, s.label) as speaker_label,
    ts.start_ms,
    ts.end_ms,
    ts.text,
    ts.confidence,
    ts.language,
    ts.words,
    ts.turn_index,
    ts.source,
    ts.revision,
    ts.edited_at
  from transcript_segments ts
  left join speakers s on s.id = ts.speaker_id
  left join meeting_participants p
    on p.id = s.participant_id and p.meeting_id = ts.meeting_id
`

/** Transcript facts of one meeting without loading it ($1 = meeting id). */
const SEGMENT_STATS_SQL = `
  select
    count(*)::int as segment_count,
    (count(*) filter (where ts.source = 'edited'))::int as edited_count,
    max(ts.edited_at) filter (where ts.source = 'edited') as edited_at,
    avg(ts.confidence) as average_confidence,
    max(ts.end_ms) as max_end_ms,
    bool_and(coalesce(p.name, s.display_name, s.label, 'Speaker') ~* 'google meet smart notes')
      as all_smart_notes,
    bool_and(
      coalesce(p.name, s.display_name, s.label, 'Speaker')
        ~* '^(speaker[[:space:]]+[0-9]+|speaker|google meet smart notes)$'
    ) as all_generic
  from transcript_segments ts
  left join speakers s on s.id = ts.speaker_id
  left join meeting_participants p
    on p.id = s.participant_id and p.meeting_id = ts.meeting_id
  where ts.meeting_id = $1
`

/** Recomputes `turn_index` of a meeting's segments by (start_ms, id) ($1 = meeting id). */
const RECOMPUTE_TURNS_SQL = `
  update transcript_segments ts
  set turn_index = ordered.turn_index
  from (
    select
      id,
      (sum(case when rn = 1 or speaker_id is distinct from previous_speaker then 1 else 0 end)
        over (order by start_ms, id rows unbounded preceding) - 1)::int as turn_index
    from (
      select
        id,
        start_ms,
        speaker_id,
        lag(speaker_id) over (order by start_ms, id) as previous_speaker,
        row_number() over (order by start_ms, id) as rn
      from transcript_segments
      where meeting_id = $1
    ) changes
  ) ordered
  where ts.id = ordered.id
    and ts.meeting_id = $1
    and ts.turn_index is distinct from ordered.turn_index
`

/** Recomputes talk time / words / segments / first start of a meeting's speakers ($1). */
const RECOMPUTE_SPEAKER_STATS_SQL = `
  update speakers s
  set talk_time_ms = coalesce(stats.talk_time_ms, 0),
      word_count = coalesce(stats.word_count, 0),
      segment_count = coalesce(stats.segment_count, 0),
      first_start_ms = stats.first_start_ms,
      updated_at = now()
  from (
    select
      sp.id,
      sum(greatest(0, ts.end_ms - ts.start_ms))::int as talk_time_ms,
      sum(
        case
          when jsonb_typeof(ts.words) = 'array' and jsonb_array_length(ts.words) > 0
            then jsonb_array_length(ts.words)
          else coalesce(array_length(regexp_split_to_array(btrim(ts.text), '[[:space:]]+'), 1), 0)
        end
      )::int as word_count,
      count(ts.id)::int as segment_count,
      min(ts.start_ms) as first_start_ms
    from speakers sp
    left join transcript_segments ts
      on ts.speaker_id = sp.id and ts.meeting_id = sp.meeting_id
    where sp.meeting_id = $1
    group by sp.id
  ) stats
  where s.id = stats.id and s.meeting_id = $1
`

const REVISION_COLUMNS = `
  id, meeting_id, segment_id, revision, text, words, speaker_id, source,
  created_by_user_id, created_at, reverted_at
`

/** Columns of `speakers s` joined to its participant `p` (name resolution). */
function speakerColumns(includeEmbeddings: boolean) {
  return `
    s.id, s.meeting_id, s.label, s.display_name, p.name as participant_name,
    s.participant_id, s.profile_id, s.mapping_status, s.suggestion, s.source,
    s.talk_time_ms, s.word_count, s.segment_count, s.first_start_ms, s.confirmed_at
    ${includeEmbeddings ? ", s.embedding, s.embedding_model" : ""}
  `
}

const SPEAKER_FROM = `
  from speakers s
  left join meeting_participants p
    on p.id = s.participant_id and p.meeting_id = s.meeting_id
`

const SPEAKER_PROFILE_COLUMNS = `
  id, workspace_id, display_name, email, aliases, confirmed_count,
  voice_embedding, embedding_model, embedding_samples
`

/** Rows per multi-row segment insert. */
const SEGMENT_INSERT_BATCH = 500

function mapMeetConferenceRecords(rows: MeetArtifactRow[]): MeetConferenceRecord[] {
  const records = new Map<string, MeetConferenceRecord>()

  for (const row of rows) {
    const existing = records.get(row.conference_record_id)
    const record =
      existing ??
      {
        id: row.conference_record_id,
        conferenceRecordName: row.conference_record_name,
        meetingId: row.meeting_id ?? undefined,
        calendarEventId: row.calendar_event_id ?? undefined,
        spaceName: row.space_name ?? undefined,
        startTime: row.conference_start_time
          ? toIso(row.conference_start_time)
          : undefined,
        endTime: row.conference_end_time ? toIso(row.conference_end_time) : undefined,
        expireTime: row.expire_time ? toIso(row.expire_time) : undefined,
        artifacts: [],
      }

    if (!existing) records.set(record.id, record)

    if (row.artifact_id && row.artifact_type && row.artifact_name) {
      record.artifacts.push({
        id: row.artifact_id,
        conferenceRecordId: row.conference_record_id,
        conferenceRecordName: row.conference_record_name,
        artifactType: row.artifact_type,
        artifactName: row.artifact_name,
        state: row.state ?? undefined,
        driveFileId: row.drive_file_id ?? undefined,
        driveFileName: row.drive_file_name ?? undefined,
        documentName: row.document_name ?? undefined,
        startTime: row.artifact_start_time
          ? toIso(row.artifact_start_time)
          : undefined,
        endTime: row.artifact_end_time ? toIso(row.artifact_end_time) : undefined,
      })
    }
  }

  return [...records.values()]
}

const ACTION_ITEM_COLUMN_LIST = [
  "id",
  "title",
  "owner",
  "status",
  "due_date",
  "priority",
  "confidence",
  "source_quote",
  "source_start_ms",
  "kind",
  "edited_by_user",
  "origin",
  "original_title",
  "completed_at",
  // M5 (022)
  "workspace_id",
  "meeting_id",
  "owner_text",
  "owner_participant_id",
  "owner_speaker_id",
  "owner_user_id",
  "due_on",
  "due_text",
  "due_source",
  "source_segment_id",
  "created_by_user_id",
  "created_at",
] as const

const ACTION_ITEM_COLUMNS = ACTION_ITEM_COLUMN_LIST.join(", ")

/** Action-item columns qualified with `alias` (the tasks store joins meetings). */
export function actionItemColumns(alias: string): string {
  return ACTION_ITEM_COLUMN_LIST.map((column) => `${alias}.${column}`).join(", ")
}

/** Meeting columns, qualified with `alias` (is_favorite is per user, M2). */
function meetingColumns(alias = "m") {
  return [
    "id",
    "title",
    "source",
    "language",
    "status",
    "retention",
    "started_at",
    "participants",
    "language_metadata",
    "external_source",
    "external_id",
    "workspace_id",
    "owner_user_id",
    "visibility",
    "duration_ms",
    "transcript_version",
    "template_key",
    "title_source",
  ]
    .map((column) => `${alias}.${column}`)
    .join(", ")
}

const SHARE_COLUMNS = `
  id, meeting_id, token, visibility, revoked, expires_at,
  included_sections, created_by, created_at, updated_at, scope, clip_id
`

/**
 * Stable participant row id. A hash of the full key: truncating base64 of
 * `${meetingId}:${name}` made every participant of a meeting share one id
 * (the meeting id fills the prefix), so all but the first were dropped.
 */
export function participantRowId(meetingId: string, key: string): string {
  return `participant_${createHash("sha256").update(`${meetingId}:${key}`).digest("hex").slice(0, 32)}`
}
async function insertCalendarParticipants(
  db: Queryable,
  meetingId: string,
  participants: string[]
) {
  const now = new Date().toISOString()

  for (const [index, participant] of participants.entries()) {
    const email = participant.includes("@") ? participant : null
    const name = email ? participant.split("@")[0] : participant

    await db.query(
      `
        insert into meeting_participants (
          id, meeting_id, name, email, role, source, attendance_status,
          confidence, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, 'calendar', 'unknown', 0.6, $6, $6)
        on conflict do nothing
      `,
      [
        participantRowId(meetingId, email ?? name),
        meetingId,
        name,
        email,
        index === 0 ? "organizer" : "attendee",
        now,
      ]
    )
  }
}

type PoolLike = Queryable & {
  connect?: () => Promise<Queryable & { release: () => void }>
}

/**
 * Runs `fn` inside a BEGIN/COMMIT block on a dedicated connection when the
 * queryable is a real pg Pool. Test fakes (no `connect`) run without a
 * transaction. Guarantees multi-statement writes are atomic — a mid-write
 * failure never leaves a meeting with a partial transcript or summary.
 */
export async function withTransaction<T>(
  client: Queryable,
  fn: (tx: Queryable) => Promise<T>
): Promise<T> {
  const pool = client as PoolLike

  if (typeof pool.connect !== "function") {
    return fn(client)
  }

  const connection = await pool.connect()

  try {
    await connection.query("begin")
    const result = await fn(connection)
    await connection.query("commit")
    return result
  } catch (error) {
    await connection.query("rollback").catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }
}

/** Participants derived from `meetings.participants` when no rows exist yet. */
function derivedParticipants(base: MeetingRecord): MeetingParticipant[] {
  return base.participants.map((participant, index) => ({
    id: `derived_${base.id}_${index}`,
    meetingId: base.id,
    name: participant.includes("@") ? participant.split("@")[0] : participant,
    email: participant.includes("@") ? participant : undefined,
    role: index === 0 ? "organizer" : "attendee",
    source: "calendar",
    attendanceStatus: "unknown",
    confidence: 0.4,
    createdAt: base.startedAt,
    updatedAt: base.startedAt,
  }))
}

function mapSuggestedAgentRun(row: SuggestedAgentRunRow): SuggestedAgentRun {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    target: row.target,
    payload: row.payload ?? {},
    response: row.response ?? {},
    status: row.status,
    lastError: row.last_error ?? undefined,
    createdAt: toIso(row.created_at),
  }
}

function mapContext(row: ContextRow): MeetingContext {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    color: row.color ?? undefined,
    kind: row.kind ?? undefined,
    createdAt: toIso(row.created_at),
  }
}

const JOB_COLUMNS = `
  id, name, status, meeting_id, payload, result, error,
  attempts, max_attempts, retry_of_job_id, started_at,
  completed_at, created_at, updated_at
`

const MEDIA_ASSET_COLUMNS = `
  id, meeting_id, storage_key, filename, content_type,
  size_bytes, retention, source, source_file_id,
  checksum_sha256, metadata, kind, derived_from_asset_id,
  duration_ms, peaks_storage_key, prepared_at, prepare_error, created_at
`

/** Media columns of list items (no metadata, M4). */
const LIST_MEDIA_ASSET_COLUMNS = MEDIA_ASSET_COLUMNS.replace("metadata, ", "")

const PARTICIPANT_COLUMNS = `
  id, meeting_id, name, email, role, source, attendance_status,
  speaker_label, confidence, created_at, updated_at
`

const SUGGESTED_RUN_COLUMNS = `
  id, meeting_id, target, payload, response, status, last_error, created_at
`

function pushValue(values: unknown[], value: unknown): string {
  values.push(value)
  return `$${values.length}`
}

/**
 * Meeting repository restricted to `scope` (M2). Every statement that reads
 * or writes `meetings` carries the scope predicate (lib/meetings/visibility);
 * meeting-id methods check the meeting first (`assertMeetingInScope`), and
 * child-id methods (action items, participants, agent runs) join back to a
 * visible meeting so a foreign id behaves exactly like a missing one.
 * Workspace-owned tables (jobs, contexts, tags, media assets) are filtered by
 * `workspace_id`.
 */
export function createPostgresMeetingRepository(
  client: Queryable,
  scope: RepoScope
): MeetingRepository {
  const workspaceId = scope.workspaceId
  const favoriteUserId = scope.kind === "member" ? scope.userId : undefined
  const defaultOwnerUserId =
    scope.kind === "member"
      ? scope.userId
      : scope.kind === "api_key"
        ? scope.ownerUserId
        : undefined

  function scoped(alias: string, values: unknown[]): string {
    return meetingScopeSql(scope, alias, values)
  }

  async function assertMeetingInScope(db: Queryable, meetingId: string) {
    const values: unknown[] = [meetingId]
    const result = await db.query(
      `select m.id from meetings m where m.id = $1 and ${scoped("m", values)}`,
      values
    )

    if (!result.rows.length) throw new Error(`Meeting not found: ${meetingId}`)
  }

  async function selectMeeting(
    db: Queryable,
    whereSql: string,
    whereValues: unknown[]
  ): Promise<MeetingRow | undefined> {
    const values = [...whereValues]
    const result = await db.query(
      `
        select ${meetingColumns("m")}
        from meetings m
        where ${whereSql} and ${scoped("m", values)}
        limit 1
      `,
      values
    )

    return result.rows[0] as MeetingRow | undefined
  }

  async function upsertWorkspaceTag(db: Queryable, meetingId: string, tag: string) {
    await db.query(
      `
        insert into tags (id, name, workspace_id)
        values ($1, $2, $3)
        on conflict (workspace_id, name) do nothing
      `,
      [createId("tag"), tag, workspaceId]
    )
    await db.query(
      `
        insert into meeting_tags (meeting_id, tag_id)
        select $1, t.id from tags t
        where t.workspace_id = $3 and t.name = $2
        on conflict do nothing
      `,
      [meetingId, tag, workspaceId]
    )
  }

  async function setLinkVisibility(db: Queryable, meetingId: string) {
    const values: unknown[] = [meetingId]

    await db.query(
      `
        update meetings m
        set visibility = 'link'
        where m.id = $1 and ${scoped("m", values)}
      `,
      values
    )
  }

  async function hydrateMeeting(
    base: MeetingRecord,
    options: GetMeetingOptions = {}
  ): Promise<MeetingRecord> {
    const includeTranscript = options.includeTranscript !== false
    const meetArtifactValues: unknown[] = [base.id]
    const meetArtifactScope = scoped("m2", meetArtifactValues)
    const [
      transcriptResult,
      summaryResult,
      actionItemsResult,
      tagsResult,
      contextsResult,
      intelligenceResult,
      suggestedRunsResult,
      mediaAssetsResult,
      participantsResult,
      meetArtifactsResult,
      aiRunsResult,
      favoriteResult,
      speakersResult,
    ] = await Promise.all([
      includeTranscript
        ? client.query(
            `${TRANSCRIPT_SELECT} where ts.meeting_id = $1 order by ts.start_ms asc, ts.id asc`,
            [base.id]
          )
        : client.query(SEGMENT_STATS_SQL, [base.id]),
      client.query(
        `
          select id, overview, language, model_provider
          from summaries
          where meeting_id = $1
          order by created_at desc
          limit 1
        `,
        [base.id]
      ),
      client.query(
        `
          select ${ACTION_ITEM_COLUMNS}
          from action_items
          where meeting_id = $1
          order by created_at asc, id asc
        `,
        [base.id]
      ),
      client.query(
        `
          select t.name
          from meeting_tags mt
          join tags t on t.id = mt.tag_id
          where mt.meeting_id = $1 and t.workspace_id = $2
          order by t.name asc
        `,
        [base.id, workspaceId]
      ),
      client.query(
        `
          select c.id, c.name, c.description, c.color, c.kind, c.created_at
          from meeting_contexts mc
          join contexts c on c.id = mc.context_id
          where mc.meeting_id = $1 and c.workspace_id = $2
          order by c.name asc
        `,
        [base.id, workspaceId]
      ),
      client.query(
        `
          select output
          from intelligence_runs
          where meeting_id = $1 and status = 'completed'
          order by created_at desc
          limit 1
        `,
        [base.id]
      ),
      client.query(
        `
          select ${SUGGESTED_RUN_COLUMNS}
          from suggested_agent_runs
          where meeting_id = $1
          order by created_at desc
        `,
        [base.id]
      ),
      client.query(
        `
          select ${MEDIA_ASSET_COLUMNS}
          from media_assets
          where meeting_id = $1 and workspace_id = $2
          order by created_at desc
        `,
        [base.id, workspaceId]
      ),
      client.query(
        `
          select ${PARTICIPANT_COLUMNS}
          from meeting_participants
          where meeting_id = $1
          order by
            case role when 'organizer' then 0 when 'attendee' then 1 else 2 end,
            name asc
        `,
        [base.id]
      ),
      client.query(
        `
          select
            mcr.id as conference_record_id,
            mcr.conference_record_name,
            mcr.meeting_id,
            mcr.calendar_event_id,
            mcr.space_name,
            mcr.start_time as conference_start_time,
            mcr.end_time as conference_end_time,
            mcr.expire_time,
            ma.id as artifact_id,
            ma.artifact_type,
            ma.artifact_name,
            ma.state,
            ma.drive_file_id,
            df.name as drive_file_name,
            ma.document_name,
            ma.start_time as artifact_start_time,
            ma.end_time as artifact_end_time
          from meet_conference_records mcr
          left join meet_artifacts ma on ma.conference_record_id = mcr.id
          left join drive_files df on df.id = ma.drive_file_id
          where mcr.meeting_id = $1
             or mcr.calendar_event_id = (
              select m2.calendar_event_id from meetings m2
              where m2.id = $1 and ${meetArtifactScope}
             )
          order by mcr.start_time desc nulls last, ma.created_at desc
        `,
        meetArtifactValues
      ),
      client.query(
        `
          select id, meeting_id, provider, task, status, metadata, model,
                 latency_ms, confidence, started_at, completed_at, error
          from ai_runs
          where meeting_id = $1
          order by started_at desc
          limit 20
        `,
        [base.id]
      ),
      favoriteUserId
        ? client.query(
            `
              select 1 as favorite
              from meeting_favorites
              where user_id = $1 and meeting_id = $2
            `,
            [favoriteUserId, base.id]
          )
        : Promise.resolve({ rows: [] as unknown[] }),
      client.query(
        `
          select ${speakerColumns(false)}
          ${SPEAKER_FROM}
          where s.meeting_id = $1
          order by s.first_start_ms asc nulls last, s.label asc
        `,
        [base.id]
      ),
    ])

    const transcript = includeTranscript
      ? (transcriptResult.rows as TranscriptRow[]).map(mapTranscriptRow)
      : undefined
    const stats = includeTranscript
      ? undefined
      : mapSegmentStats(transcriptResult.rows[0] as SegmentStatsRow | undefined)
    const mediaAssets = (mediaAssetsResult.rows as MediaAssetRow[]).map(mapMediaAsset)
    const editedSegments = transcript?.filter((segment) => segment.source === "edited") ?? []
    const editedTimes = editedSegments
      .map((segment) => segment.editedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
    const transcriptFacts = stats
      ? {
          transcriptSegmentCount: stats.segmentCount,
          editedSegmentCount: stats.editedCount,
          transcriptEditedAt: stats.editedAt,
          // Without segments: stored duration, media duration, else last segment end.
          durationMs:
            getMeetingDurationMs({ durationMs: base.durationMs, mediaAssets }) ?? stats.maxEndMs,
        }
      : {
          transcriptSegmentCount: transcript?.length ?? 0,
          editedSegmentCount: editedSegments.length,
          transcriptEditedAt: editedTimes[editedTimes.length - 1],
          durationMs: base.durationMs,
        }
    const speakers = (speakersResult.rows as SpeakerRow[])
      .filter((row) => typeof row.id === "string" && typeof row.label === "string")
      .map((row) => mapSpeaker(row))

    const latestSummary = summaryResult.rows[0] as SummaryRow | undefined
    let decisions: string[] = []

    if (latestSummary) {
      const sectionResult = await client.query(
        `
          select kind, content
          from summary_sections
          where summary_id = $1
          order by id asc
        `,
        [latestSummary.id]
      )
      const sections = sectionResult.rows as SummarySectionRow[]
      const decisionsSection = sections.find(
        (section) => section.kind === "decisions"
      )

      decisions = parseJsonArray(decisionsSection?.content)
    }

    const actionItems = (actionItemsResult.rows as ActionItemRow[]).map(
      mapActionItem
    )
    const intelligence = (intelligenceResult.rows[0] as
      | IntelligenceRunRow
      | undefined)?.output
    const participantDetails =
      (participantsResult.rows as ParticipantRow[]).map(mapParticipant)

    const hydrated: MeetingRecord = {
      ...base,
      ...transcriptFacts,
      transcriptVersion: base.transcriptVersion ?? 0,
      isFavorite: favoriteResult.rows.length > 0,
      ...(transcript ? { transcript } : {}),
      summary: latestSummary
        ? {
            overview: latestSummary.overview,
            decisions,
            actionItems,
          }
        : undefined,
      tags: (tagsResult.rows as TagRow[]).map((row) => row.name),
      contexts: (contextsResult.rows as ContextRow[]).map(mapContext),
      intelligence,
      suggestedAgentRuns: (suggestedRunsResult.rows as SuggestedAgentRunRow[]).map(
        mapSuggestedAgentRun
      ),
      mediaAssets,
      meetConferenceRecords: mapMeetConferenceRecords(
        meetArtifactsResult.rows as MeetArtifactRow[]
      ),
      aiRuns: (aiRunsResult.rows as AiRunRow[]).map(mapAiRun),
      ...(speakers.length ? { speakers } : {}),
      participantDetails:
        participantDetails.length > 0 ? participantDetails : derivedParticipants(base),
    }

    if (hydrated.durationMs === undefined) delete hydrated.durationMs

    return {
      ...hydrated,
      qualityWarnings: deriveMeetingQualityWarnings(hydrated, stats),
    }
  }

  async function getScopedMeeting(id: string, options: GetMeetingOptions = {}) {
    const row = await selectMeeting(client, "m.id = $1", [id])

    return row ? hydrateMeeting(mapMeetingRow(row), options) : undefined
  }

  /**
   * Batched hydration of list items (M4): one statement per relation for the
   * whole page (`meeting_id = any($1)`), so the query count is constant in
   * the page size. No transcript, words, summary or media metadata.
   */
  async function hydrateListItems(bases: MeetingRecord[]): Promise<MeetingListItem[]> {
    if (!bases.length) return []

    const ids = bases.map((meeting) => meeting.id)
    const [
      participantsResult,
      tagsResult,
      contextsResult,
      mediaResult,
      actionCountsResult,
      segmentCountsResult,
      favoritesResult,
    ] = await Promise.all([
      client.query(
        `
          select ${PARTICIPANT_COLUMNS}
          from meeting_participants
          where meeting_id = any($1::text[])
          order by
            meeting_id,
            case role when 'organizer' then 0 when 'attendee' then 1 else 2 end,
            name asc
        `,
        [ids]
      ),
      client.query(
        `
          select mt.meeting_id, t.name
          from meeting_tags mt
          join tags t on t.id = mt.tag_id
          where mt.meeting_id = any($1::text[]) and t.workspace_id = $2
          order by t.name asc
        `,
        [ids, workspaceId]
      ),
      client.query(
        `
          select mc.meeting_id, c.id, c.name, c.description, c.color, c.kind, c.created_at
          from meeting_contexts mc
          join contexts c on c.id = mc.context_id
          where mc.meeting_id = any($1::text[]) and c.workspace_id = $2
          order by c.name asc
        `,
        [ids, workspaceId]
      ),
      client.query(
        `
          select ${LIST_MEDIA_ASSET_COLUMNS}
          from media_assets
          where meeting_id = any($1::text[]) and workspace_id = $2
          order by created_at desc
        `,
        [ids, workspaceId]
      ),
      client.query(
        `
          select meeting_id, count(*)::int as count
          from action_items
          where meeting_id = any($1::text[])
          group by meeting_id
        `,
        [ids]
      ),
      client.query(
        `
          select meeting_id, count(*)::int as count
          from transcript_segments
          where meeting_id = any($1::text[])
          group by meeting_id
        `,
        [ids]
      ),
      favoriteUserId
        ? client.query(
            `
              select meeting_id
              from meeting_favorites
              where user_id = $1 and meeting_id = any($2::text[])
            `,
            [favoriteUserId, ids]
          )
        : Promise.resolve({ rows: [] as unknown[] }),
    ])

    const group = <T extends { meeting_id: string }>(rows: unknown[]) => {
      const byMeeting = new Map<string, T[]>()

      for (const row of rows as T[]) {
        const list = byMeeting.get(row.meeting_id) ?? []

        list.push(row)
        byMeeting.set(row.meeting_id, list)
      }
      return byMeeting
    }
    const counts = (rows: unknown[]) =>
      new Map(
        (rows as Array<{ meeting_id: string; count: number | string }>).map((row) => [
          row.meeting_id,
          Number(row.count),
        ])
      )
    const participantsByMeeting = group<ParticipantRow>(participantsResult.rows)
    const tagsByMeeting = group<TagRow & { meeting_id: string }>(tagsResult.rows)
    const contextsByMeeting = group<ContextRow & { meeting_id: string }>(contextsResult.rows)
    const mediaByMeeting = group<MediaAssetRow>(mediaResult.rows)
    const actionCounts = counts(actionCountsResult.rows)
    const segmentCounts = counts(segmentCountsResult.rows)
    const favoriteIds = new Set(
      (favoritesResult.rows as Array<{ meeting_id: string }>).map((row) => row.meeting_id)
    )

    return bases.map((base) => {
      const participantDetails = (participantsByMeeting.get(base.id) ?? []).map(mapParticipant)
      const mediaAssets = (mediaByMeeting.get(base.id) ?? []).map(mapListMediaAsset)

      return {
        ...base,
        isFavorite: favoriteIds.has(base.id),
        participantDetails: participantDetails.length
          ? participantDetails
          : derivedParticipants(base),
        tags: (tagsByMeeting.get(base.id) ?? []).map((row) => row.name),
        contexts: (contextsByMeeting.get(base.id) ?? []).map(mapContext),
        mediaAssets,
        transcriptSegmentCount: segmentCounts.get(base.id) ?? 0,
        actionItemCount: actionCounts.get(base.id) ?? 0,
        hasMedia: mediaAssets.length > 0,
      }
    })
  }

  async function requireScopedMeeting(id: string) {
    const meeting = await getScopedMeeting(id)

    if (!meeting) throw new Error(`Meeting not found: ${id}`)
    return meeting
  }

  async function insertMeeting(
    input: CreateMeetingInput,
    onConflictSql = ""
  ): Promise<MeetingRow | undefined> {
    const result = await client.query(
      `
        insert into meetings as m (
          id, title, source, language, status, retention, started_at, participants,
          external_source, external_id, workspace_id, owner_user_id, visibility
        )
        values ($6, $1, $2, $3, 'created', 'audio', $4, $5::jsonb, $7, $8, $9, $10, $11)
        ${onConflictSql}
        returning ${meetingColumns("m")}
      `,
      [
        input.title,
        input.source,
        input.language,
        input.startedAt,
        JSON.stringify(input.participants ?? []),
        createId("meet"),
        input.externalSource ?? null,
        input.externalId ?? null,
        workspaceId,
        input.ownerUserId ?? defaultOwnerUserId ?? null,
        input.visibility ?? "workspace",
      ]
    )

    return result.rows[0] as MeetingRow | undefined
  }

  async function updateScopedMeeting(
    db: Queryable,
    meetingId: string,
    setSql: string,
    setValues: unknown[]
  ): Promise<MeetingRow | undefined> {
    // setValues occupy $2.., the meeting id is $1.
    const values: unknown[] = [meetingId, ...setValues]
    const result = await db.query(
      `
        update meetings m
        set ${setSql}
        where m.id = $1 and ${scoped("m", values)}
        returning ${meetingColumns("m")}
      `,
      values
    )

    return result.rows[0] as MeetingRow | undefined
  }

  /**
   * Jobs are workspace rows; a job linked to a meeting is visible only while
   * that meeting is (same rule as every other meeting child).
   */
  function jobScopeSql(values: unknown[]): string {
    return (
      `jobs.workspace_id = ${pushValue(values, workspaceId)} and ` +
      `(jobs.meeting_id is null or exists (select 1 from meetings m ` +
      `where m.id = jobs.meeting_id and ${scoped("m", values)}))`
    )
  }

  async function findScopedJob(id: string) {
    const values: unknown[] = [id]
    const result = await client.query(
      `
        select ${JOB_COLUMNS}
        from jobs
        where id = $1 and ${jobScopeSql(values)}
        limit 1
      `,
      values
    )

    return result.rows[0] ? mapJob(result.rows[0] as JobRow) : undefined
  }

  async function updateScopedParticipant(
    participantId: string,
    patch: Parameters<MeetingRepository["updateMeetingParticipant"]>[1],
    meetingId?: string
  ): Promise<MeetingParticipant> {
    const values: unknown[] = [
      participantId,
      patch.name ?? null,
      patch.email ?? null,
      patch.role ?? null,
      patch.attendanceStatus ?? null,
      patch.speakerLabel ?? null,
    ]
    const meetingFilter = meetingId
      ? `and meeting_participants.meeting_id = ${pushValue(values, meetingId)}`
      : ""
    const result = await client.query(
      `
        update meeting_participants
        set name = coalesce($2, name),
            email = coalesce($3, email),
            role = coalesce($4, role),
            attendance_status = coalesce($5, attendance_status),
            speaker_label = coalesce($6, speaker_label),
            updated_at = now()
        where id = $1
          ${meetingFilter}
          and exists (
            select 1 from meetings m
            where m.id = meeting_participants.meeting_id and ${scoped("m", values)}
          )
        returning ${PARTICIPANT_COLUMNS}
      `,
      values
    )
    const row = result.rows[0] as ParticipantRow | undefined

    if (!row) throw new Error(`Participant not found: ${participantId}`)
    // Speaker names resolve through participants: transcript ETags change.
    await bumpTranscriptVersion(client, row.meeting_id)
    return mapParticipant(row)
  }

  /**
   * Bumps `meetings.transcript_version` (the transcript ETag) of a visible
   * meeting; optionally sets the transcript-derived duration when no media
   * duration exists. Returns the new version.
   */
  async function bumpTranscriptVersion(
    db: Queryable,
    meetingId: string,
    transcriptDurationMs?: number
  ): Promise<number> {
    const values: unknown[] = [meetingId]
    const durationSql =
      transcriptDurationMs !== undefined && transcriptDurationMs > 0
        ? `, duration_ms = case
             when exists (
               select 1 from media_assets a
               where a.meeting_id = m.id and a.workspace_id = m.workspace_id
                 and a.duration_ms is not null
             ) then m.duration_ms
             else ${pushValue(values, Math.round(transcriptDurationMs))}::int
           end`
        : ""
    const result = await db.query(
      `
        update meetings m
        set transcript_version = m.transcript_version + 1${durationSql}
        where m.id = $1 and ${scoped("m", values)}
        returning m.transcript_version
      `,
      values
    )

    return Number((result.rows[0] as { transcript_version?: number } | undefined)?.transcript_version ?? 0)
  }

  /**
   * Locks a visible meeting for a transcript edit and returns its version; an
   * invisible meeting reads as a missing segment.
   */
  async function lockMeetingForEdit(db: Queryable, meetingId: string, segmentId: string) {
    const values: unknown[] = [meetingId]
    const result = await db.query(
      `
        select m.id, m.transcript_version
        from meetings m
        where m.id = $1 and ${scoped("m", values)}
        for update of m
      `,
      values
    )
    const row = result.rows[0] as { transcript_version?: number } | undefined

    if (!row) throw new SegmentNotFoundError(segmentId)
    return Number(row.transcript_version ?? 0)
  }

  /** Locks one segment of a meeting (call after lockMeetingForEdit). */
  async function lockSegment(db: Queryable, meetingId: string, segmentId: string) {
    const result = await db.query(
      `${TRANSCRIPT_SELECT} where ts.id = $1 and ts.meeting_id = $2 for update of ts`,
      [segmentId, meetingId]
    )
    const row = result.rows[0] as TranscriptRow | undefined

    if (!row) throw new SegmentNotFoundError(segmentId)
    return mapTranscriptRow(row)
  }

  async function readSegment(db: Queryable, meetingId: string, segmentId: string) {
    const result = await db.query(
      `${TRANSCRIPT_SELECT} where ts.id = $1 and ts.meeting_id = $2`,
      [segmentId, meetingId]
    )

    return mapTranscriptRow(result.rows[0] as TranscriptRow)
  }

  /** Turn indexes and speaker stats after a speaker change (one statement each). */
  async function recomputeSpeakerDerived(db: Queryable, meetingId: string) {
    await db.query(RECOMPUTE_TURNS_SQL, [meetingId])
    await db.query(RECOMPUTE_SPEAKER_STATS_SQL, [meetingId])
  }

  async function pruneRevisions(db: Queryable, meetingId: string, segmentIds: string[]) {
    await db.query(
      `
        delete from transcript_segment_revisions r
        using (
          select id,
                 row_number() over (
                   partition by segment_id order by revision desc, created_at desc
                 ) as rank
          from transcript_segment_revisions
          where meeting_id = $1 and workspace_id = $2 and segment_id = any($3::text[])
        ) ranked
        where r.id = ranked.id and ranked.rank > $4
      `,
      [meetingId, workspaceId, segmentIds, transcriptRevisionsKeep()]
    )
  }

  async function mutationResult(
    db: Queryable,
    meetingId: string,
    segmentId: string,
    speakerChanged: boolean,
    version: number
  ): Promise<SegmentMutationResult> {
    const segment = await readSegment(db, meetingId, segmentId)

    return {
      segment,
      ...(speakerChanged
        ? { speakers: (await selectSpeakers(db, meetingId)).map((row) => mapSpeaker(row)) }
        : {}),
      version,
    }
  }

  /** Scoped meeting check that also serializes transcript writes (row lock). */
  async function lockMeetingInScope(db: Queryable, meetingId: string) {
    const values: unknown[] = [meetingId]
    const result = await db.query(
      `select m.id from meetings m where m.id = $1 and ${scoped("m", values)} for update of m`,
      values
    )

    if (!result.rows.length) throw new Error(`Meeting not found: ${meetingId}`)
  }

  /** Speakers of a meeting (call only after the meeting scope check). */
  async function selectSpeakers(
    db: Queryable,
    meetingId: string,
    options: { ids?: string[]; includeEmbeddings?: boolean; forUpdate?: boolean } = {}
  ): Promise<SpeakerRow[]> {
    const values: unknown[] = [meetingId]
    const idFilter = options.ids ? `and s.id = any(${pushValue(values, options.ids)}::text[])` : ""
    const result = await db.query(
      `
        select ${speakerColumns(Boolean(options.includeEmbeddings))}
        ${SPEAKER_FROM}
        where s.meeting_id = $1 ${idFilter}
        order by s.first_start_ms asc nulls last, s.label asc
        ${options.forUpdate ? "for update of s" : ""}
      `,
      values
    )

    return result.rows as SpeakerRow[]
  }

  function existingSpeakerRows(rows: SpeakerRow[]): ExistingSpeakerRow[] {
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      source: row.source,
      mappingStatus: row.mapping_status,
      resolvedName: row.participant_name ?? row.display_name ?? row.label,
    }))
  }

  async function insertSegments(
    db: Queryable,
    meetingId: string,
    segments: Array<TranscriptSegment & { speakerId: string; turnIndex: number; source: string }>,
    asrRunId: string | undefined
  ) {
    for (let offset = 0; offset < segments.length; offset += SEGMENT_INSERT_BATCH) {
      const batch = segments.slice(offset, offset + SEGMENT_INSERT_BATCH)

      await db.query(
        `
          insert into transcript_segments (
            id, meeting_id, speaker_id, start_ms, end_ms, text, confidence,
            language, words, turn_index, source, asr_run_id
          )
          select u.id, $1, u.speaker_id, u.start_ms, u.end_ms, u.text, u.confidence,
                 u.language, u.words::jsonb, u.turn_index, u.source, $2
          from unnest(
            $3::text[], $4::text[], $5::int[], $6::int[], $7::text[],
            $8::numeric[], $9::text[], $10::text[], $11::int[], $12::text[]
          ) as u(
            id, speaker_id, start_ms, end_ms, text, confidence,
            language, words, turn_index, source
          )
        `,
        [
          meetingId,
          asrRunId ?? null,
          batch.map((segment) => segment.id),
          batch.map((segment) => segment.speakerId),
          batch.map((segment) => Math.round(segment.startMs)),
          batch.map((segment) => Math.round(segment.endMs)),
          batch.map((segment) => segment.text),
          batch.map((segment) => segment.confidence ?? null),
          batch.map((segment) => segment.language ?? null),
          batch.map((segment) =>
            segment.words ? JSON.stringify(encodeWords(segment.words, segment.language)) : null
          ),
          batch.map((segment) => segment.turnIndex),
          batch.map((segment) => segment.source),
        ]
      )
    }
  }

  /**
   * One transaction: lock the meeting, plan speakers by label, delete the old
   * segments, upsert speakers (stats; mapping kept or reset), delete speakers
   * left without segments, insert the new segments. Never touches
   * meeting_participants.
   */
  async function selectMeetingPage(options: MeetingListOptions): Promise<{
    bases: MeetingRecord[]
    page: MeetingListPage["page"]
  }> {
    const limit = normalizeLimit(options.limit)
    const offset = normalizeOffset(options.offset)
    const sort = normalizeSort(options.sort)
    const { whereSql, values } = buildMeetingListClauses(scope, options)
    const countResult = await client.query(
      `
        select count(*)::int as total
        from meetings m
        ${whereSql}
      `,
      values
    )
    const total = Number((countResult.rows[0] as { total?: number }).total ?? 0)
    const limitIndex = values.length + 1
    const offsetIndex = values.length + 2
    const result = await client.query(
      `
      select ${meetingColumns("m")}
      from meetings m
      left join lateral (
        select max(j.created_at) as last_job_at
        from jobs j
        where j.meeting_id = m.id and j.workspace_id = m.workspace_id
      ) recent_job on true
      left join lateral (
        select max(df.imported_at) as imported_at
        from meeting_drive_files mdf
        join drive_files df on df.id = mdf.drive_file_id
        where mdf.meeting_id = m.id
      ) recent_import on true
      ${whereSql}
      order by ${meetingOrderSql(sort)}
      limit $${limitIndex}
      offset $${offsetIndex}
    `,
      [...values, limit, offset]
    )

    const bases = result.rows.map((row) => mapMeetingRow(row as MeetingRow))

    return {
      bases,
      page: {
        limit,
        offset,
        total,
        hasMore: offset + bases.length < total,
      },
    }
  }

  /** Fully hydrated page (search, timeline, memory: they read transcripts). */
  async function listFullMeetingsPage(options: MeetingListOptions = {}): Promise<{
    meetings: MeetingRecord[]
    page: MeetingListPage["page"]
  }> {
    const { bases, page } = await selectMeetingPage(options)
    const meetings = await Promise.all(bases.map((meeting) => hydrateMeeting(meeting)))

    return { meetings, page }
  }

  async function writeTranscript(
    meetingId: string,
    input: ReplaceTranscriptInput,
    preserveDiarizedMappings = false,
    preserveEdited = false
  ) {
    return withTransaction(client, async (tx) => {
      await lockMeetingInScope(tx, meetingId)

      const existing = await selectSpeakers(tx, meetingId, { forUpdate: true })
      // Edited segments that match the new transcript keep their row (and so
      // their revisions) with the edited text and words.
      const edited = preserveEdited
        ? (
            await tx.query(
              `${TRANSCRIPT_SELECT} where ts.meeting_id = $1 and ts.source = 'edited'`,
              [meetingId]
            )
          ).rows.map((row) => mapTranscriptRow(row as TranscriptRow))
        : []
      const { segments: incoming, preservedIds } = preserveEditedSegments(input.segments, edited)
      const plan = planTranscriptReplacement({
        existing: existingSpeakerRows(existing),
        segments: incoming,
        speakers: input.speakers,
        createId,
        preserveDiarizedMappings,
      })
      const kept = [...preservedIds]

      if (kept.length) {
        await tx.query(
          `delete from transcript_segments where meeting_id = $1 and not (id = any($2::text[]))`,
          [meetingId, kept]
        )
      } else {
        await tx.query(`delete from transcript_segments where meeting_id = $1`, [meetingId])
      }
      // Stale speakers are deleted after the kept segments are repointed.
      if (plan.deleteIds.length && !kept.length) {
        await tx.query(`delete from speakers where meeting_id = $1 and id = any($2::text[])`, [
          meetingId,
          plan.deleteIds,
        ])
      }

      for (const upsert of plan.upserts) {
        const stats = [
          upsert.source,
          upsert.talkTimeMs,
          upsert.wordCount,
          upsert.segmentCount,
          upsert.firstStartMs ?? null,
          upsert.embedding ?? null,
          upsert.embeddingModel ?? null,
        ]

        if (upsert.isNew) {
          await tx.query(
            `
              insert into speakers (
                id, meeting_id, label, workspace_id, source, talk_time_ms,
                word_count, segment_count, first_start_ms, embedding,
                embedding_model, mapping_status
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::real[], $11, 'unmapped')
            `,
            [upsert.id, meetingId, upsert.label, workspaceId, ...stats]
          )
          continue
        }

        await tx.query(
          `
            update speakers
            set workspace_id = $3,
                source = $4,
                talk_time_ms = $5,
                word_count = $6,
                segment_count = $7,
                first_start_ms = $8,
                embedding = coalesce($9::real[], embedding),
                embedding_model = case when $9::real[] is null then embedding_model else $10 end,
                ${
                  upsert.resetMapping
                    ? `mapping_status = 'unmapped', participant_id = null, profile_id = null,
                       display_name = null, suggestion = null, confirmed_at = null,
                       confirmed_by_user_id = null,`
                    : ""
                }
                updated_at = now()
            where id = $1 and meeting_id = $2
          `,
          [upsert.id, meetingId, workspaceId, ...stats]
        )
      }

      await insertSegments(
        tx,
        meetingId,
        plan.segments.filter((segment) => !preservedIds.has(segment.id)),
        input.asrRunId
      )

      if (kept.length) {
        const preserved = plan.segments.filter((segment) => preservedIds.has(segment.id))

        await tx.query(
          `
            update transcript_segments ts
            set speaker_id = u.speaker_id, turn_index = u.turn_index
            from unnest($2::text[], $3::text[], $4::int[]) as u(id, speaker_id, turn_index)
            where ts.id = u.id and ts.meeting_id = $1
          `,
          [
            meetingId,
            preserved.map((segment) => segment.id),
            preserved.map((segment) => segment.speakerId),
            preserved.map((segment) => segment.turnIndex),
          ]
        )
        if (plan.deleteIds.length) {
          await tx.query(`delete from speakers where meeting_id = $1 and id = any($2::text[])`, [
            meetingId,
            plan.deleteIds,
          ])
        }
      }

      await bumpTranscriptVersion(
        tx,
        meetingId,
        plan.segments.reduce((end, segment) => Math.max(end, segment.endMs), 0)
      )

      return {
        segments: plan.segments as TranscriptSegment[],
        speakers: (await selectSpeakers(tx, meetingId)).map((row) => mapSpeaker(row)),
      }
    })
  }

  async function requireSpeakerRow(db: Queryable, meetingId: string, speakerId: string) {
    const [row] = await selectSpeakers(db, meetingId, { ids: [speakerId] })

    if (!row) throw new Error(`Speaker not found: ${speakerId}`)
    return row
  }

  async function latestShare(meetingId: string, activeOnly: boolean) {
    const result = await client.query(
      `
        select ${SHARE_COLUMNS}
        from meeting_shares
        where meeting_id = $1 and scope = 'meeting'
        ${activeOnly ? "and revoked = false" : ""}
        order by created_at desc
        limit 1
      `,
      [meetingId]
    )

    return result.rows[0] as MeetingShareRow | undefined
  }

  return {
    async findMeetingByExternalId(source, externalId) {
      const row = await selectMeeting(
        client,
        "m.external_source = $1 and m.external_id = $2",
        [source, externalId]
      )

      return row ? hydrateMeeting(mapMeetingRow(row)) : undefined
    },

    async createMeetingIfAbsent(input) {
      const row = await insertMeeting(
        input,
        `on conflict (workspace_id, external_source, external_id)
           where external_id is not null
           do nothing`
      )

      if (row) {
        const meeting = mapMeetingRow(row)

        await insertCalendarParticipants(client, meeting.id, input.participants ?? [])
        return { meeting: await hydrateMeeting(meeting), created: true }
      }

      const existing = await this.findMeetingByExternalId(
        input.externalSource,
        input.externalId
      )

      if (!existing) throw new MeetingExternalIdConflictError()

      return { meeting: existing, created: false }
    },

    async discardMeeting(id) {
      return withTransaction(client, async (tx) => {
        const guardValues: unknown[] = [id]
        const guard = await tx.query(
          `
            select m.id
            from meetings m
            where m.id = $1
              and ${scoped("m", guardValues)}
              and not exists (select 1 from transcript_segments where meeting_id = m.id)
              and not exists (select 1 from summaries where meeting_id = m.id)
            for update of m
          `,
          guardValues
        )

        if (!guard.rows.length) return false

        await tx.query(
          `update jobs set meeting_id = null where meeting_id = $1 and workspace_id = $2`,
          [id, workspaceId]
        )
        await tx.query(`update ai_runs set meeting_id = null where meeting_id = $1`, [id])
        await tx.query(
          `delete from media_assets where meeting_id = $1 and workspace_id = $2`,
          [id, workspaceId]
        )
        await tx.query(`delete from meeting_participants where meeting_id = $1`, [id])
        await tx.query(`delete from meeting_tags where meeting_id = $1`, [id])
        await tx.query(`delete from action_items where meeting_id = $1`, [id])
        await tx.query(`delete from speakers where meeting_id = $1`, [id])
        await tx.query(`delete from meeting_favorites where meeting_id = $1`, [id])
        const deleteValues: unknown[] = [id]

        await tx.query(
          `delete from meetings m where m.id = $1 and ${scoped("m", deleteValues)}`,
          deleteValues
        )

        return true
      })
    },

    async listMeetings(options: MeetingListOptions = {}) {
      return (await listFullMeetingsPage(options)).meetings
    },

    async listMeetingsPage(options: MeetingListOptions = {}) {
      const { bases, page } = await selectMeetingPage(options)

      return { meetings: await hydrateListItems(bases), page }
    },

    async getMeeting(id: string, options: GetMeetingOptions = {}) {
      return getScopedMeeting(id, options)
    },

    async createMeeting(input: CreateMeetingInput) {
      const row = await insertMeeting(input)
      const meeting = mapMeetingRow(row as MeetingRow)

      await insertCalendarParticipants(client, meeting.id, input.participants ?? [])

      return hydrateMeeting(meeting)
    },

    async updateMeetingStatus(id: string, status: MeetingStatus) {
      const row = await updateScopedMeeting(client, id, "status = $2", [status])

      if (!row) throw new Error(`Meeting not found: ${id}`)
      return hydrateMeeting(mapMeetingRow(row))
    },

    async createMediaAsset(input) {
      // The asset inherits the workspace of a meeting this scope can see; a
      // foreign meeting id inserts nothing.
      const kind = input.kind ?? "original"
      const values: unknown[] = [
        createId("asset"),
        input.meetingId,
        input.storageKey,
        input.filename ?? null,
        input.contentType,
        input.sizeBytes,
        input.retention ?? "audio",
        input.source ?? null,
        input.sourceFileId ?? null,
        input.checksumSha256 ?? null,
        JSON.stringify(input.metadata ?? {}),
        kind,
        input.derivedFromAssetId ?? null,
        input.durationMs === undefined ? null : Math.round(input.durationMs),
      ]
      const result = await client.query(
        `
          insert into media_assets (
            id, meeting_id, storage_key, filename, content_type, size_bytes,
            retention, source, source_file_id, checksum_sha256, metadata,
            kind, derived_from_asset_id, duration_ms, workspace_id
          )
          select $1, m.id, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                 $12, $13, $14::int, m.workspace_id
          from meetings m
          where m.id = $2 and ${scoped("m", values)}
          returning ${MEDIA_ASSET_COLUMNS}
        `,
        values
      )
      const row = result.rows[0] as MediaAssetRow | undefined

      if (!row) throw new Error(`Meeting not found: ${input.meetingId}`)

      // A derived playback rendition never changes the meeting status.
      if (kind === "original") {
        await updateScopedMeeting(client, input.meetingId, "status = 'media_uploaded'", [])
      }

      return mapMediaAsset(row)
    },

    async findMediaAssetBySourceFile(source, sourceFileId, options = {}) {
      const values: unknown[] = [source, sourceFileId, workspaceId]
      const meetingFilter = options.meetingId
        ? `and a.meeting_id = ${pushValue(values, options.meetingId)}`
        : ""
      const result = await client.query(
        `
          select ${MEDIA_ASSET_COLUMNS
            .split(",")
            .map((column) => `a.${column.trim()}`)
            .join(", ")}
          from media_assets a
          where a.source = $1 and a.source_file_id = $2 and a.workspace_id = $3
          ${meetingFilter}
          and exists (
            select 1 from meetings m
            where m.id = a.meeting_id and ${scoped("m", values)}
          )
          order by a.created_at desc
          limit 1
        `,
        values
      )

      const row = result.rows[0] as MediaAssetRow | undefined
      return row ? mapMediaAsset(row) : undefined
    },

    async replaceTranscriptSegments(meetingId, segments) {
      // Legacy entry point: keeps speaker labels/sources of segments read
      // back from the meeting, derives stats, never creates participants.
      await assertMeetingInScope(client, meetingId)

      const existing = await selectSpeakers(client, meetingId)

      // The same transcript re-written (cleanup): manual edits always win.
      await writeTranscript(
        meetingId,
        legacySegmentsToTranscript(existingSpeakerRows(existing), segments),
        true,
        true
      )
      return segments
    },

    async replaceTranscript(meetingId, input, options = {}) {
      // preserveEdited = the same transcript re-written (cleanup): it also keeps
      // confirmed/rejected diarized speaker mappings of surviving labels.
      const preserve = options.preserveEdited === true

      return writeTranscript(meetingId, input, preserve, preserve)
    },

    async listMeetingSpeakers(meetingId, options = {}) {
      await assertMeetingInScope(client, meetingId)

      return (
        await selectSpeakers(client, meetingId, {
          includeEmbeddings: options.includeEmbeddings,
        })
      ).map((row) => mapSpeaker(row, options.includeEmbeddings))
    },

    async updateMeetingSpeaker(meetingId, speakerId, patch) {
      await assertMeetingInScope(client, meetingId)

      const values: unknown[] = [speakerId, meetingId]
      const sets: string[] = []
      const guards: string[] = []

      if (patch.displayName !== undefined) {
        sets.push(`display_name = ${pushValue(values, patch.displayName)}`)
      }
      if (patch.participantId !== undefined) {
        const placeholder = pushValue(values, patch.participantId)

        sets.push(`participant_id = ${placeholder}`)
        // The participant must belong to the same meeting (checked in-statement).
        if (patch.participantId !== null) {
          guards.push(
            `exists (select 1 from meeting_participants mp where mp.id = ${placeholder} and mp.meeting_id = s.meeting_id)`
          )
        }
      }
      if (patch.profileId !== undefined) {
        const placeholder = pushValue(values, patch.profileId)

        sets.push(`profile_id = ${placeholder}`)
        if (patch.profileId !== null) {
          guards.push(
            `exists (select 1 from speaker_profiles sp where sp.id = ${placeholder} and sp.workspace_id = ${pushValue(values, workspaceId)})`
          )
        }
      }
      if (patch.suggestion !== undefined) {
        sets.push(
          `suggestion = ${pushValue(
            values,
            patch.suggestion === null ? null : JSON.stringify(patch.suggestion)
          )}::jsonb`
        )
      }
      if (patch.mappingStatus !== undefined) {
        const placeholder = pushValue(values, patch.mappingStatus)

        sets.push(`mapping_status = ${placeholder}`)
        sets.push(
          `confirmed_at = case when ${placeholder} = 'confirmed' then now() else null end`
        )
      }
      if (patch.confirmedByUserId !== undefined) {
        sets.push(`confirmed_by_user_id = ${pushValue(values, patch.confirmedByUserId)}`)
      }
      sets.push("updated_at = now()")

      const result = await client.query(
        `
          update speakers s
          set ${sets.join(", ")}
          where s.id = $1 and s.meeting_id = $2
          ${guards.map((guard) => `and ${guard}`).join(" ")}
          returning s.id
        `,
        values
      )

      if (!result.rows.length) throw new Error(`Speaker not found: ${speakerId}`)
      await bumpTranscriptVersion(client, meetingId)
      return mapSpeaker(await requireSpeakerRow(client, meetingId, speakerId))
    },

    async mergeMeetingSpeakers(meetingId, sourceId, targetId) {
      if (sourceId === targetId) throw new Error("Cannot merge a speaker into itself")

      return withTransaction(client, async (tx) => {
        await lockMeetingInScope(tx, meetingId)

        const rows = await selectSpeakers(tx, meetingId, {
          ids: [sourceId, targetId],
          forUpdate: true,
        })
        const source = rows.find((row) => row.id === sourceId)
        const target = rows.find((row) => row.id === targetId)

        if (!source) throw new Error(`Speaker not found: ${sourceId}`)
        if (!target) throw new Error(`Speaker not found: ${targetId}`)

        // Only speaker_id and turn_index change: text and words are untouched.
        await tx.query(
          `update transcript_segments set speaker_id = $3 where meeting_id = $1 and speaker_id = $2`,
          [meetingId, sourceId, targetId]
        )
        await tx.query(
          `
            update speakers
            set talk_time_ms = talk_time_ms + $3,
                word_count = word_count + $4,
                segment_count = segment_count + $5,
                first_start_ms = least(first_start_ms, $6),
                updated_at = now()
            where id = $2 and meeting_id = $1
          `,
          [
            meetingId,
            targetId,
            optionalNumber(source.talk_time_ms) ?? 0,
            optionalNumber(source.word_count) ?? 0,
            optionalNumber(source.segment_count) ?? 0,
            source.first_start_ms,
          ]
        )
        await tx.query(`delete from speakers where id = $2 and meeting_id = $1`, [
          meetingId,
          sourceId,
        ])

        const segmentRows = (
          await tx.query(
            `
              select id, speaker_id, start_ms
              from transcript_segments
              where meeting_id = $1
              order by start_ms asc, id asc
            `,
            [meetingId]
          )
        ).rows as Array<{ id: string; speaker_id: string | null; start_ms: number }>
        const turns = computeTurnIndexes(
          segmentRows.map((row) => ({ startMs: row.start_ms, speakerId: row.speaker_id })),
          (row) => row.speakerId ?? ""
        )

        if (segmentRows.length) {
          await tx.query(
            `
              update transcript_segments ts
              set turn_index = u.turn_index
              from unnest($2::text[], $3::int[]) as u(id, turn_index)
              where ts.id = u.id and ts.meeting_id = $1
            `,
            [meetingId, segmentRows.map((row) => row.id), turns]
          )
        }

        await bumpTranscriptVersion(tx, meetingId)
        return mapSpeaker(await requireSpeakerRow(tx, meetingId, targetId))
      })
    },

    async setSpeakerSuggestions(meetingId, items) {
      await assertMeetingInScope(client, meetingId)

      for (const item of items) {
        // Confirmed / rejected mappings are never overwritten automatically.
        await client.query(
          `
            update speakers s
            set suggestion = $3::jsonb,
                mapping_status = coalesce($4, s.mapping_status),
                participant_id = case when $5::boolean then $6 else s.participant_id end,
                confirmed_at = case
                  when coalesce($4, s.mapping_status) = 'confirmed' then now()
                  else s.confirmed_at
                end,
                updated_at = now()
            where s.id = $1 and s.meeting_id = $2
              and s.mapping_status not in ('confirmed', 'rejected')
              and (
                $6::text is null or exists (
                  select 1 from meeting_participants mp
                  where mp.id = $6 and mp.meeting_id = s.meeting_id
                )
              )
          `,
          [
            item.speakerId,
            meetingId,
            item.suggestion === null ? null : JSON.stringify(item.suggestion),
            item.mappingStatus ?? null,
            item.participantId !== undefined,
            item.participantId ?? null,
          ]
        )
      }

      if (items.length) await bumpTranscriptVersion(client, meetingId)
      return (await selectSpeakers(client, meetingId)).map((row) => mapSpeaker(row))
    },

    async listSpeakerProfiles() {
      const result = await client.query(
        `
          select ${SPEAKER_PROFILE_COLUMNS}
          from speaker_profiles
          where workspace_id = $1
          order by confirmed_count desc, display_name asc
        `,
        [workspaceId]
      )

      return (result.rows as SpeakerProfileRow[]).map(mapSpeakerProfile)
    },

    async recordConfirmedSpeaker(input) {
      return withTransaction(client, async (tx) => {
        await assertMeetingInScope(tx, input.meetingId)

        const speakerResult = await tx.query(
          `select id, embedding, embedding_model from speakers where id = $1 and meeting_id = $2`,
          [input.speakerId, input.meetingId]
        )
        const speaker = speakerResult.rows[0] as
          | { id: string; embedding: number[] | null; embedding_model: string | null }
          | undefined

        if (!speaker) throw new Error(`Speaker not found: ${input.speakerId}`)

        const name = input.participant.name.normalize("NFC").trim().replace(/\s+/gu, " ")
        const email = input.participant.email?.trim().toLowerCase() || undefined
        const existingResult = email
          ? await tx.query(
              `
                select ${SPEAKER_PROFILE_COLUMNS}
                from speaker_profiles
                where workspace_id = $1 and lower(email) = $2
                limit 1
                for update
              `,
              [workspaceId, email]
            )
          : await tx.query(
              `
                select ${SPEAKER_PROFILE_COLUMNS}
                from speaker_profiles
                where workspace_id = $1 and email is null and lower(display_name) = $2
                limit 1
                for update
              `,
              [workspaceId, normalizeProfileName(name)]
            )
        const existing = existingResult.rows[0] as SpeakerProfileRow | undefined
        const embedding = input.embedding ?? speaker.embedding?.map(Number) ?? undefined
        const embeddingModel = input.embedding
          ? input.embeddingModel
          : (speaker.embedding_model ?? undefined)
        let voiceEmbedding = existing?.voice_embedding?.map(Number) ?? null
        let profileModel = existing?.embedding_model ?? null
        let samples = optionalNumber(existing?.embedding_samples) ?? 0

        if (embedding?.length) {
          const sameModel =
            voiceEmbedding !== null && profileModel === (embeddingModel ?? null)

          voiceEmbedding = sameModel
            ? runningMeanEmbedding(voiceEmbedding as number[], samples, embedding)
            : [...embedding]
          profileModel = embeddingModel ?? null
          samples = sameModel ? samples + 1 : 1
        }

        const profileResult = existing
          ? await tx.query(
              `
                update speaker_profiles
                set display_name = $3,
                    aliases = $4::text[],
                    confirmed_count = confirmed_count + 1,
                    last_meeting_id = $5,
                    last_confirmed_at = now(),
                    voice_embedding = $6::real[],
                    embedding_model = $7,
                    embedding_samples = $8,
                    updated_at = now()
                where id = $1 and workspace_id = $2
                returning ${SPEAKER_PROFILE_COLUMNS}
              `,
              [
                existing.id,
                workspaceId,
                name,
                unionAliases(existing.aliases ?? [], input.aliases),
                input.meetingId,
                voiceEmbedding,
                profileModel,
                samples,
              ]
            )
          : await tx.query(
              `
                insert into speaker_profiles (
                  id, workspace_id, display_name, email, aliases, confirmed_count,
                  last_meeting_id, last_confirmed_at, voice_embedding,
                  embedding_model, embedding_samples
                )
                values ($1, $2, $3, $4, $5::text[], 1, $6, now(), $7::real[], $8, $9)
                returning ${SPEAKER_PROFILE_COLUMNS}
              `,
              [
                createId("speaker_profile"),
                workspaceId,
                name,
                email ?? null,
                unionAliases(input.aliases),
                input.meetingId,
                voiceEmbedding,
                profileModel,
                samples,
              ]
            )
        const profile = mapSpeakerProfile(profileResult.rows[0] as SpeakerProfileRow)

        await tx.query(
          `update speakers set profile_id = $1, updated_at = now() where id = $2 and meeting_id = $3`,
          [profile.id, input.speakerId, input.meetingId]
        )
        await bumpTranscriptVersion(tx, input.meetingId)

        return profile
      })
    },

    async getMeetingTranscript(meetingId): Promise<MeetingTranscript | undefined> {
      // Version first: a concurrent edit can only make the segments newer
      // than the ETag (the next conditional request then refetches).
      const values: unknown[] = [meetingId]
      const meetingResult = await client.query(
        `
          select m.id, m.language, m.transcript_version
          from meetings m
          where m.id = $1 and ${scoped("m", values)}
        `,
        values
      )
      const meeting = meetingResult.rows[0] as
        | { language: string | null; transcript_version: number | null }
        | undefined

      if (!meeting) return undefined

      const [segmentsResult, speakerRows] = await Promise.all([
        client.query(
          `${TRANSCRIPT_SELECT} where ts.meeting_id = $1 order by ts.start_ms asc, ts.id asc`,
          [meetingId]
        ),
        selectSpeakers(client, meetingId),
      ])

      return {
        meetingId,
        version: Number(meeting.transcript_version ?? 0),
        segments: (segmentsResult.rows as TranscriptRow[]).map(mapTranscriptRow),
        speakers: speakerRows
          .filter((row) => typeof row.id === "string" && typeof row.label === "string")
          .map((row) => mapSpeaker(row)),
        language: meeting.language ?? undefined,
      }
    },

    async getTranscriptVersion(meetingId) {
      const values: unknown[] = [meetingId]
      const result = await client.query(
        `select m.transcript_version from meetings m where m.id = $1 and ${scoped("m", values)}`,
        values
      )
      const row = result.rows[0] as { transcript_version: number | null } | undefined

      return row ? Number(row.transcript_version ?? 0) : undefined
    },

    async updateTranscriptSegment(meetingId, segmentId, patch) {
      return withTransaction(client, async (tx) => {
        const currentVersion = await lockMeetingForEdit(tx, meetingId, segmentId)
        const current = await lockSegment(tx, meetingId, segmentId)

        if ((current.revision ?? 0) !== patch.expectedRevision) {
          throw new TranscriptConflictError(current)
        }

        let targetSpeakerId: string | undefined

        if (patch.speakerId !== undefined) {
          const found = await tx.query(
            `select id from speakers where id = $1 and meeting_id = $2`,
            [patch.speakerId, meetingId]
          )

          if (!found.rows.length) throw new TranscriptSpeakerNotFoundError(patch.speakerId)
          targetSpeakerId = patch.speakerId
        }

        const textChanged = patch.text !== undefined && patch.text !== current.text
        const speakerChanged =
          patch.newSpeakerName !== undefined ||
          (targetSpeakerId !== undefined && targetSpeakerId !== current.speakerId)

        if (!textChanged && !speakerChanged) return { segment: current, version: currentVersion }

        if (patch.newSpeakerName !== undefined) {
          const labels = (
            await tx.query(`select label from speakers where meeting_id = $1`, [meetingId])
          ).rows.map((row) => String((row as { label: string }).label))

          targetSpeakerId = createId("speaker")
          await tx.query(
            `
              insert into speakers (
                id, meeting_id, label, workspace_id, source, display_name,
                mapping_status, confirmed_at, confirmed_by_user_id,
                talk_time_ms, word_count, segment_count
              )
              values ($1, $2, $3, $4, 'manual', $5, 'confirmed', now(), $6, 0, 0, 0)
            `,
            [
              targetSpeakerId,
              meetingId,
              nextSpeakerLabel(labels),
              workspaceId,
              patch.newSpeakerName,
              patch.actorUserId ?? null,
            ]
          )
        }

        let segmentIds = [segmentId]

        if (speakerChanged && patch.scope === "turn" && current.turnIndex !== undefined) {
          const turn = await tx.query(
            `
              select id from transcript_segments
              where meeting_id = $1 and turn_index = $2 and speaker_id is not distinct from $3
            `,
            [meetingId, current.turnIndex, current.speakerId ?? null]
          )

          segmentIds = [
            ...new Set([segmentId, ...turn.rows.map((row) => (row as { id: string }).id)]),
          ]
        }

        // Prior state of every changed segment (undo).
        await tx.query(
          `
            insert into transcript_segment_revisions (
              id, workspace_id, meeting_id, segment_id, revision, text, words,
              speaker_id, source, created_by_user_id
            )
            select u.revision_id, $1, ts.meeting_id, ts.id, ts.revision, ts.text, ts.words,
                   ts.speaker_id, ts.source, $3
            from unnest($4::text[], $5::text[]) as u(revision_id, segment_id)
            join transcript_segments ts on ts.id = u.segment_id and ts.meeting_id = $2
          `,
          [
            workspaceId,
            meetingId,
            patch.actorUserId ?? null,
            segmentIds.map(() => createId("rev")),
            segmentIds,
          ]
        )

        const words = textChanged
          ? (patch.words ??
            realignWords(current.words, patch.text as string, {
              startMs: current.startMs,
              endMs: current.endMs,
            }))
          : undefined

        await tx.query(
          `
            update transcript_segments
            set text = case when id = $3 and $4::boolean then $5 else text end,
                words = case when id = $3 and $4::boolean then $6::jsonb else words end,
                speaker_id = coalesce($7, speaker_id),
                source = 'edited',
                revision = revision + 1,
                edited_at = now(),
                edited_by_user_id = $8
            where meeting_id = $1 and id = any($2::text[])
          `,
          [
            meetingId,
            segmentIds,
            segmentId,
            textChanged,
            textChanged ? patch.text : null,
            words ? JSON.stringify(encodeWords(words, current.language)) : null,
            speakerChanged ? (targetSpeakerId ?? null) : null,
            patch.actorUserId ?? null,
          ]
        )

        if (speakerChanged) await recomputeSpeakerDerived(tx, meetingId)
        await pruneRevisions(tx, meetingId, segmentIds)

        const version = await bumpTranscriptVersion(tx, meetingId)

        return mutationResult(tx, meetingId, segmentId, speakerChanged, version)
      })
    },

    async undoTranscriptSegment(meetingId, segmentId, options) {
      return withTransaction(client, async (tx) => {
        await lockMeetingForEdit(tx, meetingId, segmentId)

        const current = await lockSegment(tx, meetingId, segmentId)

        if ((current.revision ?? 0) !== options.expectedRevision) {
          throw new TranscriptConflictError(current)
        }

        const revisionResult = await tx.query(
          `
            select ${REVISION_COLUMNS}
            from transcript_segment_revisions
            where meeting_id = $1 and workspace_id = $2 and segment_id = $3
              and reverted_at is null
            order by revision desc, created_at desc
            limit 1
            for update
          `,
          [meetingId, workspaceId, segmentId]
        )
        const revision = revisionResult.rows[0] as RevisionRow | undefined

        if (!revision) throw new NothingToUndoError(segmentId)

        // A speaker merged away since keeps the segment on its current speaker.
        const restoredSpeaker = revision.speaker_id
          ? (
              await tx.query(`select id from speakers where id = $1 and meeting_id = $2`, [
                revision.speaker_id,
                meetingId,
              ])
            ).rows.length
            ? revision.speaker_id
            : undefined
          : undefined
        const speakerChanged =
          restoredSpeaker !== undefined && restoredSpeaker !== current.speakerId

        await tx.query(
          `
            update transcript_segments
            set text = $3,
                words = $4::jsonb,
                speaker_id = coalesce($5, speaker_id),
                source = $6,
                revision = revision + 1,
                edited_at = now(),
                edited_by_user_id = $7
            where id = $2 and meeting_id = $1
          `,
          [
            meetingId,
            segmentId,
            revision.text,
            revision.words === null || revision.words === undefined
              ? null
              : typeof revision.words === "string"
                ? revision.words
                : JSON.stringify(revision.words),
            restoredSpeaker ?? null,
            revision.source,
            options.actorUserId ?? null,
          ]
        )
        await tx.query(
          `
            update transcript_segment_revisions
            set reverted_at = now()
            where id = $1 and meeting_id = $2 and workspace_id = $3
          `,
          [revision.id, meetingId, workspaceId]
        )

        if (speakerChanged) await recomputeSpeakerDerived(tx, meetingId)

        const version = await bumpTranscriptVersion(tx, meetingId)

        return mutationResult(tx, meetingId, segmentId, speakerChanged, version)
      })
    },

    async listTranscriptRevisions(meetingId, segmentId) {
      await assertMeetingInScope(client, meetingId)

      const result = await client.query(
        `
          select ${REVISION_COLUMNS}
          from transcript_segment_revisions
          where meeting_id = $1 and workspace_id = $2 and segment_id = $3
          order by revision desc, created_at desc
        `,
        [meetingId, workspaceId, segmentId]
      )

      return (result.rows as RevisionRow[]).map(mapRevision)
    },

    async renameMeeting(id, title) {
      // A user rename: AI titles never overwrite it (M5).
      const row = await updateScopedMeeting(client, id, "title = $2, title_source = 'user'", [title])

      if (!row) throw new Error(`Meeting not found: ${id}`)
      return mapMeetingRow(row)
    },

    async deleteMeeting(id): Promise<DeletedMeeting | undefined> {
      return withTransaction(client, async (tx) => {
        const values: unknown[] = [id]
        const locked = await tx.query(
          `
            select m.id, m.title
            from meetings m
            where m.id = $1 and ${scoped("m", values)}
            for update of m
          `,
          values
        )
        const meeting = locked.rows[0] as { title: string } | undefined

        if (!meeting) return undefined

        const assets = (
          await tx.query(
            `
              select storage_key, peaks_storage_key
              from media_assets
              where meeting_id = $1 and workspace_id = $2
            `,
            [id, workspaceId]
          )
        ).rows as Array<{ storage_key: string | null; peaks_storage_key: string | null }>
        const deleteValues: unknown[] = [id]

        // Child rows cascade (migration 021); jobs and ai_runs keep a null meeting.
        await tx.query(
          `delete from meetings m where m.id = $1 and ${scoped("m", deleteValues)}`,
          deleteValues
        )

        return {
          storageKeys: [
            ...new Set(
              assets.flatMap((asset) =>
                [asset.storage_key, asset.peaks_storage_key].filter((key): key is string =>
                  Boolean(key)
                )
              )
            ),
          ],
          title: meeting.title,
          assetCount: assets.length,
        }
      })
    },

    async updateMediaAssetPreparation(assetId, patch) {
      const values: unknown[] = [assetId, workspaceId]
      const sets: string[] = []

      if (patch.durationMs !== undefined) {
        sets.push(
          `duration_ms = ${pushValue(values, patch.durationMs === null ? null : Math.round(patch.durationMs))}::int`
        )
      }
      if (patch.peaksStorageKey !== undefined) {
        sets.push(`peaks_storage_key = ${pushValue(values, patch.peaksStorageKey)}`)
      }
      if (patch.preparedAt !== undefined) {
        sets.push(`prepared_at = ${pushValue(values, patch.preparedAt)}::timestamptz`)
      }
      if (patch.prepareError !== undefined) {
        sets.push(`prepare_error = ${pushValue(values, patch.prepareError)}`)
      }
      if (!sets.length) sets.push("kind = a.kind")

      const result = await client.query(
        `
          update media_assets a
          set ${sets.join(", ")}
          where a.id = $1 and a.workspace_id = $2
            and exists (
              select 1 from meetings m
              where m.id = a.meeting_id and ${scoped("m", values)}
            )
          returning ${MEDIA_ASSET_COLUMNS}
        `,
        values
      )
      const row = result.rows[0] as MediaAssetRow | undefined

      if (!row) throw new Error(`Media asset not found: ${assetId}`)
      return mapMediaAsset(row)
    },

    async setMeetingDurationMs(meetingId, durationMs, source) {
      const values: unknown[] = [meetingId, Math.round(durationMs)]
      // A transcript end never overrides a probed media duration.
      const transcriptGuard =
        source === "transcript"
          ? `and not exists (
               select 1 from media_assets a
               where a.meeting_id = m.id and a.workspace_id = m.workspace_id
                 and a.duration_ms is not null
             )`
          : ""
      const result = await client.query(
        `
          update meetings m
          set duration_ms = $2::int
          where m.id = $1 and ${scoped("m", values)}
          ${transcriptGuard}
          returning m.id
        `,
        values
      )

      if (!result.rows.length && source === "media") {
        throw new Error(`Meeting not found: ${meetingId}`)
      }
    },

    async upsertMeetingIntelligence(
      meetingId,
      intelligence,
      provider = "local",
      model = "heuristic-v1"
    ) {
      return withTransaction(client, async (tx) => {
        await assertMeetingInScope(tx, meetingId)

        const existingResult = await tx.query(
          `
            select ${ACTION_ITEM_COLUMNS}
            from action_items
            where meeting_id = $1
            order by created_at asc, id asc
            for update
          `,
          [meetingId]
        )
        const existing = (existingResult.rows as ActionItemRow[]).map(mapActionItem)
        const plan = mergeActionItems(existing, intelligence.actionItems, () =>
          createId("act")
        )

        if (plan.remove.length) {
          await tx.query(
            `delete from action_items where meeting_id = $1 and id = any($2)`,
            [meetingId, plan.remove]
          )
        }

        // M5: owner ids are re-validated in SQL (same meeting / workspace
        // member) so a stale or derived id can never break the FK or leak.
        const m5Values = (item: ActionItem) => [
          workspaceId,
          item.ownerText ?? null,
          item.ownerParticipantId ?? null,
          item.ownerSpeakerId ?? null,
          item.ownerUserId ?? null,
          isDateOnly(item.dueOn) ? item.dueOn : null,
          item.dueText ?? null,
          item.dueSource ?? null,
          item.sourceSegmentId ?? null,
        ]

        for (const item of plan.update) {
          await tx.query(
            `
              update action_items
              set title = $3,
                  owner = $4,
                  status = $5,
                  due_date = $6,
                  priority = coalesce($7, priority),
                  confidence = $8,
                  source_quote = $9,
                  source_start_ms = $10,
                  kind = coalesce($11, kind),
                  origin = 'ai',
                  original_title = $3,
                  edited_by_user = false,
                  completed_at = null,
                  workspace_id = $12,
                  owner_text = $13,
                  owner_participant_id = (
                    select mp.id from meeting_participants mp
                    where mp.id = $14 and mp.meeting_id = $2
                  ),
                  owner_speaker_id = (
                    select sp.id from speakers sp where sp.id = $15 and sp.meeting_id = $2
                  ),
                  owner_user_id = (
                    select mb.user_id from memberships mb
                    where mb.user_id = $16 and mb.workspace_id = $12
                  ),
                  due_on = $17::date,
                  due_text = $18,
                  due_source = $19,
                  source_segment_id = $20,
                  updated_at = now()
              where id = $1 and meeting_id = $2
            `,
            [
              item.id,
              meetingId,
              item.title,
              item.owner ?? null,
              item.status,
              coerceDueDate(item.dueDate),
              item.priority ?? null,
              item.confidence ?? null,
              item.sourceQuote ?? null,
              item.sourceStartMs ?? null,
              item.kind ?? null,
              ...m5Values(item),
            ]
          )
        }

        for (const item of plan.insert) {
          await tx.query(
            `
              insert into action_items (
                id, meeting_id, title, owner, status, due_date, priority,
                confidence, source_quote, source_start_ms, kind,
                origin, original_title, edited_by_user,
                workspace_id, owner_text, owner_participant_id, owner_speaker_id,
                owner_user_id, due_on, due_text, due_source, source_segment_id
              )
              values (
                $1, $2, $3, $4, $5, $6, coalesce($7, 'normal'), $8, $9, $10,
                coalesce($11, 'explicit'), 'ai', $3, false,
                $12, $13,
                (select mp.id from meeting_participants mp where mp.id = $14 and mp.meeting_id = $2),
                (select sp.id from speakers sp where sp.id = $15 and sp.meeting_id = $2),
                (select mb.user_id from memberships mb where mb.user_id = $16 and mb.workspace_id = $12),
                $17::date, $18, $19, $20
              )
            `,
            [
              item.id,
              meetingId,
              item.title,
              item.owner ?? null,
              item.status,
              coerceDueDate(item.dueDate),
              item.priority ?? null,
              item.confidence ?? null,
              item.sourceQuote ?? null,
              item.sourceStartMs ?? null,
              item.kind ?? null,
              ...m5Values(item),
            ]
          )
        }

        const finalResult = await tx.query(
          `
            select ${ACTION_ITEM_COLUMNS}
            from action_items
            where meeting_id = $1
            order by created_at asc, id asc
          `,
          [meetingId]
        )
        const actionItems = (finalResult.rows as ActionItemRow[]).map(mapActionItem)
        const persisted: MeetingIntelligence = {
          ...intelligence,
          actionItems: actionItems as MeetingIntelligence["actionItems"],
        }
        const runId = createId("intel")

        await tx.query(
          `
            insert into intelligence_runs (id, meeting_id, provider, model, input, output, status)
            values ($1, $2, $3, $4, '{}'::jsonb, $5::jsonb, 'completed')
          `,
          [runId, meetingId, provider, model, JSON.stringify(persisted)]
        )
        await updateScopedMeeting(
          tx,
          meetingId,
          "language_metadata = $2::jsonb, status = 'completed'",
          [JSON.stringify(intelligence.languageMetadata)]
        )

        const summaryResult = await tx.query(
          `
            insert into summaries (
              id, meeting_id, overview, language, model_provider, intelligence_run_id,
              template_key, prompt_version
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            returning id
          `,
          [
            createId("summary"),
            meetingId,
            intelligence.overview,
            intelligence.languageMetadata.primaryLanguage,
            provider,
            runId,
            intelligence.generation?.templateKey ?? null,
            intelligence.generation?.promptVersion ?? null,
          ]
        )
        const summaryId = (summaryResult.rows[0] as { id: string }).id

        await tx.query(
          `
            insert into summary_sections (id, summary_id, kind, content)
            values ($1, $2, 'decisions', $3::jsonb)
          `,
          [createId("section"), summaryId, JSON.stringify(intelligence.decisions)]
        )

        await tx.query(`delete from meeting_tags where meeting_id = $1`, [meetingId])
        for (const tag of intelligence.tags) {
          await upsertWorkspaceTag(tx, meetingId, tag)
        }

        return persisted
      })
    },

    async updateActionItem(id, patch) {
      const timeZone = getTaskTimeZone()
      let anchor = new Date().toISOString()

      // A due phrase without a date is parsed against the meeting start.
      if (patch.dueOn === undefined && patch.dueText) {
        const lookupValues: unknown[] = [id]
        const lookup = await client.query(
          `
            select m.started_at
            from action_items ai
            join meetings m on m.id = ai.meeting_id
            where ai.id = $1 and ${scoped("m", lookupValues)}
          `,
          lookupValues
        )
        const row = lookup.rows[0] as { started_at: string | Date } | undefined

        if (!row) throw new Error(`Action item not found: ${id}`)
        anchor = toIso(row.started_at)
      }

      const due = resolveDuePatch(patch, anchor, timeZone)
      const values: unknown[] = [id]
      const param = (value: unknown) => {
        values.push(value)
        return `$${values.length}`
      }
      const sets: string[] = []

      if (patch.title !== undefined) sets.push(`title = ${param(patch.title)}`)
      if (patch.priority !== undefined) sets.push(`priority = ${param(patch.priority)}`)
      if (patch.status !== undefined) {
        const status = param(patch.status)

        sets.push(
          `status = ${status}`,
          `completed_at = case when ${status}::text = 'done' then coalesce(completed_at, now()) else null end`
        )
      }
      if (hasOwnerPatch(patch)) {
        const text = param(ownerTextOf(patch))
        const participant = param(patch.ownerParticipantId ?? null)
        const user = param(patch.ownerUserId ?? null)
        const ws = param(workspaceId)
        const participantSql = `select mp.id from meeting_participants mp where mp.id = ${participant} and mp.meeting_id = action_items.meeting_id`

        sets.push(
          `owner_text = ${text}`,
          `owner_participant_id = (${participantSql})`,
          `owner_speaker_id = (select sp.id from speakers sp where sp.participant_id = ${participant} and sp.meeting_id = action_items.meeting_id order by sp.first_start_ms asc nulls last, sp.id asc limit 1)`,
          `owner_user_id = (select mb.user_id from memberships mb where mb.user_id = ${user} and mb.workspace_id = ${ws})`,
          `owner = coalesce(${text}, (select mp.name from meeting_participants mp where mp.id = ${participant} and mp.meeting_id = action_items.meeting_id))`
        )
      }
      if (due) {
        sets.push(
          `due_on = ${param(due.dueOn)}::date`,
          `due_text = ${param(due.dueText)}`,
          `due_source = ${param(due.dueSource)}`,
          `due_date = ${param(due.dueDate)}::timestamptz`
        )
      }
      sets.push(`edited_by_user = edited_by_user or ${param(isContentPatch(patch))}`, "updated_at = now()")

      const result = await client.query(
        `
          update action_items
          set ${sets.join(",\n              ")}
          where id = $1
            and exists (
              select 1 from meetings m
              where m.id = action_items.meeting_id and ${scoped("m", values)}
            )
          returning ${ACTION_ITEM_COLUMNS}
        `,
        values
      )
      const row = result.rows[0] as ActionItemRow | undefined

      if (!row) throw new Error(`Action item not found: ${id}`)
      return mapActionItem(row)
    },

    async createActionItem(meetingId, input, actor) {
      const title = input.title.trim()

      if (!title) throw new Error("Action item title is required")

      const meetingRow = await selectMeeting(client, "m.id = $1", [meetingId])

      if (!meetingRow) throw new Error(`Meeting not found: ${meetingId}`)

      const dueText = input.dueText?.trim() || null
      const dueOn = isDateOnly(input.dueOn)
        ? input.dueOn
        : dueText
          ? (parseDueDate(dueText, {
              anchor: toIso(meetingRow.started_at),
              timeZone: getTaskTimeZone(),
            })?.date ?? null)
          : null
      const result = await client.query(
        `
          insert into action_items (
            id, meeting_id, workspace_id, title, owner, status, due_date, priority,
            kind, origin, original_title, edited_by_user,
            owner_text, owner_participant_id, owner_speaker_id, owner_user_id,
            due_on, due_text, due_source, source_segment_id, source_start_ms,
            created_by_user_id
          )
          values (
            $1, $2, $3, $4,
            coalesce($5, (select mp.name from meeting_participants mp where mp.id = $6 and mp.meeting_id = $2)),
            'open', $7, coalesce($8, 'normal'),
            'explicit', 'user', $4, true,
            $5,
            (select mp.id from meeting_participants mp where mp.id = $6 and mp.meeting_id = $2),
            (select sp.id from speakers sp where sp.participant_id = $6 and sp.meeting_id = $2 order by sp.first_start_ms asc nulls last, sp.id asc limit 1),
            (select mb.user_id from memberships mb where mb.user_id = $9 and mb.workspace_id = $3),
            $10::date, $11, $12,
            (select ts.id from transcript_segments ts where ts.id = $13 and ts.meeting_id = $2),
            $14,
            (select u.id from users u where u.id = $15)
          )
          returning ${ACTION_ITEM_COLUMNS}
        `,
        [
          createId("act"),
          meetingId,
          workspaceId,
          title,
          input.ownerText?.trim() || null,
          input.ownerParticipantId ?? null,
          dueOn ? dueDateFromDueOn(dueOn) : null,
          input.priority ?? null,
          input.ownerUserId ?? null,
          dueOn,
          dueText,
          dueOn || dueText ? "user" : null,
          input.sourceSegmentId ?? null,
          input.sourceStartMs ?? null,
          actor.userId ?? null,
        ]
      )

      const row = result.rows[0] as ActionItemRow | undefined

      if (!row) throw new Error("Unable to create action item")
      return mapActionItem(row)
    },

    async deleteActionItem(id) {
      const values: unknown[] = [id]
      const result = await client.query(
        `
          delete from action_items
          where id = $1
            and exists (
              select 1 from meetings m
              where m.id = action_items.meeting_id and ${scoped("m", values)}
            )
          returning id
        `,
        values
      )

      return result.rows.length > 0
    },

    async setMeetingTemplate(id, templateKey) {
      const row = await updateScopedMeeting(client, id, "template_key = $2", [templateKey])

      if (!row) throw new Error(`Meeting not found: ${id}`)
      return mapMeetingRow(row)
    },

    async applyAiTitle(id, title) {
      const values: unknown[] = [id, title]
      const result = await client.query(
        `
          update meetings m
          set title = $2, title_source = 'ai'
          where m.id = $1 and m.title_source <> 'user' and ${scoped("m", values)}
          returning m.id
        `,
        values
      )

      return result.rows.length > 0
    },

    async setMeetingTitle(id, title, source: MeetingTitleSource) {
      const row = await updateScopedMeeting(client, id, "title = $2, title_source = $3", [
        title,
        source,
      ])

      if (!row) throw new Error(`Meeting not found: ${id}`)
      return mapMeetingRow(row)
    },

    async createJob(input) {
      const nowId = input.id ?? createId("job")
      const values: unknown[] = [
        nowId,
        input.name,
        input.status ?? "queued",
        input.meetingId ?? null,
        JSON.stringify(input.payload ?? {}),
        input.retryOfJobId ?? null,
        input.maxAttempts ?? null,
        workspaceId,
      ]
      // The job links its meeting only when this scope can see it; a foreign
      // or missing meeting id leaves meeting_id null (the payload keeps it,
      // and the worker's workspace-scoped lookup then fails permanently).
      const result = await client.query(
        `
          insert into jobs (
            id, name, status, meeting_id, payload, retry_of_job_id, max_attempts,
            workspace_id
          )
          values (
            $1, $2, $3,
            (select m.id from meetings m where m.id = $4 and ${scoped("m", values)}),
            $5::jsonb, $6, coalesce($7::integer, 3), $8
          )
          on conflict (id) do update
            set status = excluded.status,
                payload = excluded.payload,
                max_attempts = excluded.max_attempts,
                updated_at = now()
            where jobs.workspace_id = excluded.workspace_id
          returning ${JOB_COLUMNS}
        `,
        values
      )
      const row = result.rows[0] as JobRow | undefined

      // A conflicting id owned by another workspace updates nothing.
      if (!row) throw new Error(`Job id already in use: ${nowId}`)
      return mapJob(row)
    },

    async updateJob(id, patch) {
      const values: unknown[] = [
        id,
        patch.status ?? null,
        patch.result ? JSON.stringify(patch.result) : null,
        patch.error ?? null,
        patch.attempts ?? null,
      ]
      const result = await client.query(
        `
          update jobs
          set status = coalesce($2, status),
              result = coalesce($3::jsonb, result),
              error = $4,
              attempts = coalesce($5, attempts),
              started_at = case
                when $2 = 'active' then coalesce(started_at, now())
                else started_at
              end,
              completed_at = case
                when $2 in ('completed', 'failed') then now()
                else completed_at
              end,
              updated_at = now()
          where id = $1 and ${jobScopeSql(values)}
          returning ${JOB_COLUMNS}
        `,
        values
      )
      const row = result.rows[0] as JobRow | undefined

      if (!row) throw new Error(`Job not found: ${id}`)
      return mapJob(row)
    },

    async getJob(id) {
      return findScopedJob(id)
    },

    async listJobs(filters = {}) {
      const values: unknown[] = []
      const clauses = [jobScopeSql(values)]

      if (filters.meetingId) {
        clauses.push(`meeting_id = ${pushValue(values, filters.meetingId)}`)
      }
      if (filters.status) {
        clauses.push(`status = ${pushValue(values, filters.status)}`)
      }

      const result = await client.query(
        `
          select ${JOB_COLUMNS}
          from jobs
          where ${clauses.join(" and ")}
          order by created_at desc
          limit 100
        `,
        values
      )

      return result.rows.map((row) => mapJob(row as JobRow))
    },

    async searchMeetings(query: string, options: { limit?: number } = {}) {
      return (
        await listFullMeetingsPage({
          query,
          limit: options.limit,
          sort: "recent",
        })
      ).meetings
    },

    async askMeetingMemory(
      meetingId: string,
      question: string
    ): Promise<MeetingAnswer> {
      const meeting = await requireScopedMeeting(meetingId)
      const normalizedQuestion = question.toLowerCase()
      const tokens = normalizedQuestion
        .split(/\s+/)
        .filter((token) => token.length > 3)
      const transcriptMatch = meeting.transcript?.find((segment) =>
        tokens.some((token) => segment.text.toLowerCase().includes(token))
      )

      return {
        answer:
          meeting.intelligence?.overview ??
          meeting.summary?.overview ??
          transcriptMatch?.text ??
          "No summary is available for this meeting yet.",
        citations: transcriptMatch
          ? [
              {
                meetingId,
                segmentId: transcriptMatch.id,
                startMs: transcriptMatch.startMs,
              },
            ]
          : [],
      }
    },

    async getMeetingIntelligence(meetingId: string) {
      const values: unknown[] = [meetingId]
      const result = await client.query(
        `
          select ir.output
          from intelligence_runs ir
          join meetings m on m.id = ir.meeting_id
          where ir.meeting_id = $1 and ${scoped("m", values)}
          order by ir.created_at desc
          limit 1
        `,
        values
      )

      return (result.rows[0] as IntelligenceRunRow | undefined)?.output
    },

    async runMeetingIntelligence(meetingId: string) {
      const meeting = await requireScopedMeeting(meetingId)

      await this.updateMeetingStatus(meetingId, "summarizing")
      const intelligence = buildMeetingIntelligence(meeting)

      await this.updateMeetingStatus(meetingId, "indexing")
      return this.upsertMeetingIntelligence(meetingId, intelligence)
    },

    async listContexts(): Promise<MeetingContext[]> {
      const result = await client.query(
        `
          select id, name, description, color, kind, created_at
          from contexts
          where workspace_id = $1
          order by name asc
        `,
        [workspaceId]
      )

      return (result.rows as ContextRow[]).map(mapContext)
    },

    async createContext(input: CreateContextInput): Promise<MeetingContext> {
      const result = await client.query(
        `
          insert into contexts (id, name, description, workspace_id)
          values ($1, $2, $3, $4)
          returning id, name, description, color, kind, created_at
        `,
        [createId("ctx"), input.name, input.description ?? null, workspaceId]
      )

      return mapContext(result.rows[0] as ContextRow)
    },

    async linkMeetingContext(meetingId: string, contextId: string) {
      await assertMeetingInScope(client, meetingId)

      const context = await client.query(
        `select id from contexts where id = $1 and workspace_id = $2`,
        [contextId, workspaceId]
      )

      if (!context.rows.length) throw new Error(`Context not found: ${contextId}`)

      await client.query(
        `
          insert into meeting_contexts (meeting_id, context_id)
          values ($1, $2)
          on conflict do nothing
        `,
        [meetingId, contextId]
      )

      return requireScopedMeeting(meetingId)
    },

    async listRooms(): Promise<Array<MeetingContext & { meetingCount: number }>> {
      // Counts only meetings this scope can see.
      const values: unknown[] = [workspaceId]
      const visible = scoped("m", values)
      const result = await client.query(
        `
          select c.id, c.name, c.description, c.color, c.kind, c.created_at,
                 count(mc.meeting_id)::int as meeting_count
          from contexts c
          left join meeting_contexts mc
            on mc.context_id = c.id
           and exists (
             select 1 from meetings m
             where m.id = mc.meeting_id and ${visible}
           )
          where c.workspace_id = $1
          group by c.id, c.name, c.description, c.color, c.kind, c.created_at
          order by c.name asc
        `,
        values
      )

      return result.rows.map((row) => {
        const context = row as ContextRow & { meeting_count: number }

        return {
          ...mapContext(context),
          meetingCount: Number(context.meeting_count ?? 0),
        }
      })
    },

    async listMeetingsByContext(contextId: string): Promise<MeetingRecord[]> {
      const values: unknown[] = [contextId]
      const result = await client.query(
        `
          select ${meetingColumns("m")}
          from meetings m
          join meeting_contexts mc on mc.meeting_id = m.id
          where mc.context_id = $1 and ${scoped("m", values)}
          order by m.started_at desc
          limit 100
        `,
        values
      )
      const bases = result.rows.map((row) => mapMeetingRow(row as MeetingRow))

      return Promise.all(bases.map((meeting) => hydrateMeeting(meeting)))
    },

    async updateMeetingTags(meetingId: string, tags: string[]) {
      await assertMeetingInScope(client, meetingId)

      const normalizedTags = [...new Set(tags.map((tag) => tag.trim()))].filter(
        Boolean
      )

      await client.query(`delete from meeting_tags where meeting_id = $1`, [
        meetingId,
      ])

      for (const tag of normalizedTags) {
        await upsertWorkspaceTag(client, meetingId, tag)
      }

      return requireScopedMeeting(meetingId)
    },

    async updateMeetingFavorite(meetingId: string, favorite: boolean) {
      if (!favoriteUserId) {
        throw new MeetingScopeError(
          "Favorites are per user and need a signed-in member",
          400
        )
      }

      await assertMeetingInScope(client, meetingId)

      if (favorite) {
        await client.query(
          `
            insert into meeting_favorites (user_id, meeting_id)
            values ($1, $2)
            on conflict do nothing
          `,
          [favoriteUserId, meetingId]
        )
      } else {
        await client.query(
          `delete from meeting_favorites where user_id = $1 and meeting_id = $2`,
          [favoriteUserId, meetingId]
        )
      }

      return requireScopedMeeting(meetingId)
    },

    async createMeetingShare(input): Promise<MeetingShare> {
      await assertMeetingInScope(client, input.meetingId)

      // A share link only works while the meeting is `link`-visible.
      await setLinkVisibility(client, input.meetingId)

      const existing = await latestShare(input.meetingId, true)

      if (existing) return mapMeetingShare(existing)

      const result = await client.query(
        `
          insert into meeting_shares (
            id, meeting_id, token, included_sections, created_by
          )
          values ($1, $2, $3, $4::jsonb, $5)
          returning ${SHARE_COLUMNS}
        `,
        [
          createId("share"),
          input.meetingId,
          crypto.randomUUID().replaceAll("-", ""),
          JSON.stringify(input.includedSections ?? DEFAULT_SHARE_SECTIONS),
          input.createdBy ?? null,
        ]
      )

      return mapMeetingShare(result.rows[0] as MeetingShareRow)
    },

    async updateMeetingVisibility(meetingId, visibility): Promise<MeetingRecord> {
      const row = await withTransaction(client, async (tx) => {
        const updated = await updateScopedMeeting(
          tx,
          meetingId,
          "visibility = $2",
          [visibility]
        )

        if (!updated) return undefined

        // Leaving `link` revokes the meeting-scope shares in the same
        // transaction; going `private` also revokes clip shares (M5).
        if (visibility !== "link") {
          await tx.query(
            `
              update meeting_shares
              set revoked = true, updated_at = now()
              where meeting_id = $1 and revoked = false
                ${visibility === "private" ? "" : "and scope = 'meeting'"}
            `,
            [meetingId]
          )
        }

        return updated
      })

      if (!row) throw new Error(`Meeting not found: ${meetingId}`)
      return hydrateMeeting(mapMeetingRow(row))
    },

    async updateMeetingShare(meetingId, patch): Promise<MeetingShare> {
      await assertMeetingInScope(client, meetingId)

      // Operate on the latest ACTIVE share so an edit never silently mutates a
      // revoked link. The one exception is an explicit un-revoke
      // (patch.revoked === false), which must be able to reactivate the latest
      // (revoked) share.
      const wantsUnrevoke = patch.revoked === false
      const current = await latestShare(meetingId, !wantsUnrevoke)

      if (patch.regenerate) {
        if (current) {
          await client.query(
            `update meeting_shares set revoked = true, updated_at = now() where id = $1`,
            [current.id]
          )
        }

        return this.createMeetingShare({
          meetingId,
          includedSections: patch.includedSections,
        })
      }

      if (!current) {
        return this.createMeetingShare({
          meetingId,
          includedSections: patch.includedSections,
        })
      }

      if (wantsUnrevoke) await setLinkVisibility(client, meetingId)

      const result = await client.query(
        `
          update meeting_shares
          set revoked = coalesce($2, revoked),
              included_sections = coalesce($3::jsonb, included_sections),
              updated_at = now()
          where id = $1
          returning ${SHARE_COLUMNS}
        `,
        [
          current.id,
          patch.revoked ?? null,
          patch.includedSections
            ? JSON.stringify(patch.includedSections)
            : null,
        ]
      )

      return mapMeetingShare(result.rows[0] as MeetingShareRow)
    },

    async getShareByToken(token) {
      const values: unknown[] = [token]
      const result = await client.query(
        `
          select ${SHARE_COLUMNS
            .split(",")
            .map((column) => `s.${column.trim()}`)
            .join(", ")}
          from meeting_shares s
          join meetings m on m.id = s.meeting_id
          where s.token = $1
            and s.scope = 'meeting'
            and s.revoked = false
            and (s.expires_at is null or s.expires_at > now())
            and m.visibility = 'link'
            and ${scoped("m", values)}
          limit 1
        `,
        values
      )
      const row = result.rows[0] as MeetingShareRow | undefined

      if (!row) return undefined

      const meeting = await getScopedMeeting(row.meeting_id)

      return meeting ? { share: mapMeetingShare(row), meeting } : undefined
    },

    async listMeetingParticipants(meetingId) {
      const meeting = await requireScopedMeeting(meetingId)

      if (
        meeting.participantDetails?.length &&
        !meeting.participantDetails.every((participant) =>
          participant.id.startsWith("derived_")
        )
      ) {
        return meeting.participantDetails
      }

      for (const [index, participant] of meeting.participants.entries()) {
        const email = participant.includes("@") ? participant : null
        const name = email ? participant.split("@")[0] : participant

        await client.query(
          `
            insert into meeting_participants (
              id, meeting_id, name, email, role, source, attendance_status,
              confidence
            )
            values ($1, $2, $3, $4, $5, 'calendar', 'unknown', 0.5)
            on conflict (id) do nothing
          `,
          [
            participantRowId(meetingId, email ?? name),
            meetingId,
            name,
            email,
            index === 0 ? "organizer" : "attendee",
          ]
        )
      }

      if (meeting.participants.length) {
        const refreshed = await getScopedMeeting(meetingId)

        return refreshed?.participantDetails ?? []
      }

      return []
    },

    async updateMeetingParticipant(participantId, patch) {
      return updateScopedParticipant(participantId, patch)
    },

    async assignSpeakerToParticipant(meetingId, speakerLabel, participantId) {
      await assertMeetingInScope(client, meetingId)

      // The participant must belong to `meetingId`: checked in the UPDATE
      // itself, so a participant of another meeting is never modified.
      const participant = await updateScopedParticipant(
        participantId,
        { speakerLabel },
        meetingId
      )
      const speakerResult = await client.query(
        `
          select s.id
          ${SPEAKER_FROM}
          where s.meeting_id = $1
            and (s.label = $2 or coalesce(p.name, s.display_name, s.label) = $2)
          order by (s.label = $2) desc
          limit 1
        `,
        [meetingId, speakerLabel]
      )
      const speaker = speakerResult.rows[0] as { id: string } | undefined

      // The name reaches segments through the speaker → participant join;
      // segment text and words are never rewritten.
      if (speaker) {
        await this.updateMeetingSpeaker(meetingId, speaker.id, {
          participantId,
          mappingStatus: "confirmed",
        })
      }

      return participant
    },

    async createExportRecord(input): Promise<ExportRecord> {
      await assertMeetingInScope(client, input.meetingId)

      const result = await client.query(
        `
          insert into export_records (id, meeting_id, format, status, metadata)
          values ($1, $2, $3, 'created', $4::jsonb)
          returning id, meeting_id, format, status, metadata, created_at
        `,
        [
          createId("export"),
          input.meetingId,
          input.format,
          JSON.stringify(input.metadata ?? {}),
        ]
      )

      return mapExportRecord(result.rows[0] as ExportRecordRow)
    },

    async approveAgentRun(id): Promise<SuggestedAgentRun> {
      const values: unknown[] = [id]
      const result = await client.query(
        `
          update suggested_agent_runs
          set status = 'queued'
          where id = $1
            and exists (
              select 1 from meetings m
              where m.id = suggested_agent_runs.meeting_id and ${scoped("m", values)}
            )
          returning ${SUGGESTED_RUN_COLUMNS}
        `,
        values
      )
      const row = result.rows[0] as SuggestedAgentRunRow | undefined

      if (!row) throw new Error(`Agent run not found: ${id}`)
      return mapSuggestedAgentRun(row)
    },

    async createSuggestedAgentRun(input): Promise<SuggestedAgentRun> {
      await assertMeetingInScope(client, input.meetingId)

      const result = await client.query(
        `
          insert into suggested_agent_runs (id, meeting_id, target, payload, status)
          values ($1, $2, $3, $4::jsonb, 'suggested')
          returning ${SUGGESTED_RUN_COLUMNS}
        `,
        [
          createId("agent_suggestion"),
          input.meetingId,
          input.target,
          JSON.stringify(input.payload),
        ]
      )

      return mapSuggestedAgentRun(result.rows[0] as SuggestedAgentRunRow)
    },
  }
}

/**
 * Cross-workspace share-token lookup for the public share pages. The token is
 * the capability: it resolves only while the share is active and unexpired
 * AND the meeting's visibility is `link`; the meeting is then loaded through
 * a system repository of its own workspace.
 */
export function createPostgresShareLookup(client: Queryable): {
  getShareByToken: MeetingRepository["getShareByToken"]
  getShareMediaByToken: GetShareMediaByToken
} {
  return {
    /**
     * Media-route variant: one share/meeting query plus one media_assets
     * query (scoped to the meeting's workspace) — never hydrates the
     * transcript, summary, speakers or participants.
     */
    async getShareMediaByToken(token) {
      const result = await client.query(
        `
          select ${SHARE_COLUMNS
            .split(",")
            .map((column) => `s.${column.trim()}`)
            .join(", ")},
                 m.workspace_id as meeting_workspace_id,
                 m.visibility as meeting_visibility
          from meeting_shares s
          join meetings m on m.id = s.meeting_id
          where s.token = $1
            and s.scope = 'meeting'
            and s.revoked = false
            and (s.expires_at is null or s.expires_at > now())
            and m.visibility = 'link'
          limit 1
        `,
        [token]
      )
      const row = result.rows[0] as
        | (MeetingShareRow & { meeting_workspace_id: string; meeting_visibility: MeetingVisibility })
        | undefined

      if (!row) return undefined

      const assets = await client.query(
        `
          select ${MEDIA_ASSET_COLUMNS}
          from media_assets
          where meeting_id = $1 and workspace_id = $2
          order by created_at desc
        `,
        [row.meeting_id, row.meeting_workspace_id]
      )

      return {
        share: mapMeetingShare(row),
        meeting: {
          id: row.meeting_id,
          workspaceId: row.meeting_workspace_id,
          visibility: row.meeting_visibility,
        },
        mediaAssets: (assets.rows as MediaAssetRow[]).map(mapMediaAsset),
      }
    },

    async getShareByToken(token) {
      const result = await client.query(
        `
          select s.id, s.meeting_id, s.token, s.visibility, s.revoked,
                 s.expires_at, s.included_sections, s.created_by,
                 s.created_at, s.updated_at, s.scope, s.clip_id,
                 m.workspace_id as meeting_workspace_id
          from meeting_shares s
          join meetings m on m.id = s.meeting_id
          where s.token = $1
            and s.scope = 'meeting'
            and s.revoked = false
            and (s.expires_at is null or s.expires_at > now())
            and m.visibility = 'link'
          limit 1
        `,
        [token]
      )
      const row = result.rows[0] as
        | (MeetingShareRow & { meeting_workspace_id: string })
        | undefined

      if (!row) return undefined

      const meeting = await createPostgresMeetingRepository(client, {
        kind: "system",
        workspaceId: row.meeting_workspace_id,
      }).getMeeting(row.meeting_id)

      return meeting ? { share: mapMeetingShare(row), meeting } : undefined
    },
  }
}
