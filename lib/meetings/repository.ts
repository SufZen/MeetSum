import { mergeActionItems } from "@/lib/meetings/action-item-merge"
import type { MeetingStatus } from "@/lib/meetings/state"
import {
  legacySegmentsToTranscript,
  planTranscriptReplacement,
  type ExistingSpeakerRow,
} from "@/lib/meetings/speakers/transcript-plan"
import {
  computeTurnIndexes,
  normalizeProfileName,
  runningMeanEmbedding,
  segmentWordCount,
  unionAliases,
} from "@/lib/meetings/speakers/stats"
import {
  nextSpeakerLabel,
  preserveEditedSegments,
  realignWords,
  transcriptRevisionsKeep,
} from "@/lib/meetings/transcript-edit"
import type { TranscriptWord } from "@/lib/meetings/transcript-words"
import { getMeetingDurationMs } from "@/lib/meetings/duration"
import { canViewMeeting } from "@/lib/meetings/visibility"
import { DEFAULT_SHARE_SECTIONS } from "@/lib/sharing/share-sections"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"
import { parseDueDate, dueDateFromDueOn } from "@/lib/tasks/due-date"
import {
  hasOwnerPatch,
  isContentPatch,
  isDateOnly,
  ownerTextOf,
  resolveDuePatch,
} from "@/lib/tasks/patch"
import { getTaskTimeZone } from "@/lib/tasks/time-zone"
import {
  buildMeetingIntelligence,
  type MeetingIntelligence,
  type MeetingLanguageMetadata,
  type MeetingTag,
} from "@/lib/intelligence"

export type MeetingSource =
  | "upload"
  | "pwa_recorder"
  | "google_meet"
  | "desktop_recorder"
  | "meeting_bot"
  | "zoom"
  | "teams"

export type ActionItem = {
  id: string
  title: string
  owner?: string
  status: "open" | "done"
  dueDate?: string
  priority?: "low" | "normal" | "high" | "urgent"
  confidence?: number
  sourceQuote?: string
  sourceStartMs?: number
  kind?: "explicit" | "inferred"
  editedByUser?: boolean
  origin?: "ai" | "user"
  originalTitle?: string
  completedAt?: string
  /** Owner as spoken/written (M5); `owner` stays the display name. */
  ownerText?: string
  ownerParticipantId?: string
  ownerSpeakerId?: string
  ownerUserId?: string
  /** Calendar due date `YYYY-MM-DD` (M5); `dueDate` stays for compatibility. */
  dueOn?: string
  /** Raw due phrase, e.g. "עד יום ראשון" (M5). */
  dueText?: string
  dueSource?: ActionItemDueSource
  /** Confidence of `dueOn` (parser rule or capped AI date); not a column. */
  dueConfidence?: number
  sourceSegmentId?: string
  meetingId?: string
  workspaceId?: string
  /** Who created a user task (M5 `created_by_user_id`). */
  createdByUserId?: string
  createdAt?: string
}

export type ActionItemDueSource = "parser" | "ai" | "user"

/**
 * Action-item edit (M5). Legacy callers send `owner`/`dueDate`; `null` clears
 * an M5 field. Package B implements the M5 fields.
 */
export type ActionItemPatch = {
  title?: string
  status?: ActionItem["status"]
  priority?: ActionItem["priority"]
  owner?: string
  dueDate?: string
  ownerText?: string | null
  ownerParticipantId?: string | null
  ownerUserId?: string | null
  dueOn?: string | null
  dueText?: string | null
}

/** A user-created action item (M5). */
export type CreateActionItemInput = {
  title: string
  ownerText?: string
  ownerParticipantId?: string
  ownerUserId?: string
  dueOn?: string
  dueText?: string
  priority?: ActionItem["priority"]
  sourceSegmentId?: string
  sourceStartMs?: number
}

export type ActionItemActor = { userId?: string }

export type MeetingTitleSource = "source" | "ai" | "user"

export type TranscriptSegment = {
  id: string
  speaker: string
  startMs: number
  endMs: number
  text: string
  confidence?: number
  language?: string
  /** `speakers.id` of the segment's speaker (M3). */
  speakerId?: string
  /** Word timings (M3); absent on legacy segments. */
  words?: TranscriptWord[]
  /** Increments on every speaker change (M3). */
  turnIndex?: number
  /** Where the segment came from, e.g. `asr`, `meet` or `edited` (M3/M4). */
  source?: string
  /** Increments on every edit/undo (M4); 0 for untouched segments. */
  revision?: number
  /** Last manual edit (M4). */
  editedAt?: string
}

export type SpeakerMappingStatus = "unmapped" | "suggested" | "confirmed" | "rejected"

export type SpeakerSuggestionReason = {
  kind:
    | "meet_alignment"
    | "self_intro"
    | "addressed_by_name"
    | "single_remaining"
    | "organizer_owner"
    | "workspace_memory"
    | "voiceprint"
  detail: string
  weight: number
}

export type SpeakerSuggestion = {
  participantId?: string
  profileId?: string
  name: string
  email?: string
  score: number
  reasons: SpeakerSuggestionReason[]
  computedAt: string
}

/** One diarized speaker of a meeting (`speakers` row, M3). */
export type MeetingSpeaker = {
  id: string
  meetingId: string
  label: string
  displayName?: string
  participantId?: string
  profileId?: string
  mappingStatus: SpeakerMappingStatus
  suggestion?: SpeakerSuggestion
  source: string
  talkTimeMs: number
  wordCount: number
  segmentCount: number
  firstStartMs?: number
  confirmedAt?: string
  /** Voice embedding; only returned by `listMeetingSpeakers(…, {includeEmbeddings})`. */
  embedding?: number[]
  embeddingModel?: string
}

export type ListMeetingSpeakersOptions = {
  /** Include diarization voice embeddings (voiceprint matching). */
  includeEmbeddings?: boolean
}

/** Workspace memory of a confirmed speaker (`speaker_profiles`, M3). */
export type SpeakerProfile = {
  id: string
  workspaceId: string
  displayName: string
  email?: string
  aliases: string[]
  confirmedCount: number
  voiceEmbedding?: number[]
  embeddingModel?: string
}

/** Per-speaker stats written by `replaceTranscript` (M3). */
export type TranscriptSpeakerInput = {
  label: string
  source?: string
  talkTimeMs: number
  wordCount: number
  segmentCount: number
  firstStartMs?: number
  embedding?: number[]
  embeddingModel?: string
}

export type ReplaceTranscriptInput = {
  segments: TranscriptSegment[]
  speakers: TranscriptSpeakerInput[]
  asrRunId?: string
}

export type ReplaceTranscriptOptions = {
  /**
   * Keep existing `source='edited'` segments that match the new transcript
   * (M4; used by transcript cleanup, never by a full re-ASR).
   */
  preserveEdited?: boolean
}

/** A prior state of an edited segment (`transcript_segment_revisions`, M4). */
export type TranscriptRevision = {
  id: string
  meetingId: string
  segmentId: string
  revision: number
  text: string
  words?: TranscriptWord[]
  speakerId?: string
  source: string
  createdByUserId?: string
  createdAt: string
  revertedAt?: string
}

/** Full transcript of one meeting with its speakers (M4). */
export type MeetingTranscript = {
  meetingId: string
  /** `meetings.transcript_version`; bumps on every transcript mutation. */
  version: number
  segments: TranscriptSegment[]
  speakers: MeetingSpeaker[]
  /** Meeting primary language (`dir` fallback for mixed/unknown segments). */
  language?: string
}

/** Manual edit of one segment (M4). At most one of speakerId/newSpeakerName. */
export type SegmentPatch = {
  /** Revision the client edited; a mismatch raises TranscriptConflictError. */
  expectedRevision: number
  text?: string
  words?: TranscriptWord[]
  speakerId?: string
  newSpeakerName?: string
  /** `turn` reassigns every segment of the same turn and old speaker. */
  scope?: "segment" | "turn"
  actorUserId?: string
}

export type SegmentMutationResult = {
  segment: TranscriptSegment
  /** Present when speakers changed (reassignment, new speaker, stats). */
  speakers?: MeetingSpeaker[]
  version: number
}

/** The segment changed since the client read it; carries the current state. */
export class TranscriptConflictError extends Error {
  readonly segment: TranscriptSegment

  constructor(segment: TranscriptSegment) {
    super(`Transcript segment changed: ${segment.id}`)
    this.name = "TranscriptConflictError"
    this.segment = segment
  }
}

/** The segment does not exist in a meeting visible to the scope. */
export class SegmentNotFoundError extends Error {
  constructor(segmentId: string) {
    super(`Transcript segment not found: ${segmentId}`)
    this.name = "SegmentNotFoundError"
  }
}

/** `SegmentPatch.speakerId` is not a speaker of the segment's meeting. */
export class TranscriptSpeakerNotFoundError extends Error {
  constructor(speakerId: string) {
    super(`Speaker not found: ${speakerId}`)
    this.name = "TranscriptSpeakerNotFoundError"
  }
}

/** Undo found no revision left to restore. */
export class NothingToUndoError extends Error {
  constructor(segmentId: string) {
    super(`Nothing to undo for segment: ${segmentId}`)
    this.name = "NothingToUndoError"
  }
}

/** Result of `deleteMeeting`: object keys to delete after the commit. */
export type DeletedMeeting = {
  /** Media, derived renditions and peaks objects of the meeting. */
  storageKeys: string[]
  title: string
  assetCount: number
}

export type MeetingSpeakerPatch = {
  displayName?: string | null
  participantId?: string | null
  profileId?: string | null
  mappingStatus?: SpeakerMappingStatus
  suggestion?: SpeakerSuggestion | null
  confirmedByUserId?: string | null
}

export type SpeakerSuggestionUpdate = {
  speakerId: string
  suggestion: SpeakerSuggestion | null
  mappingStatus?: SpeakerMappingStatus
  participantId?: string | null
}

export type RecordConfirmedSpeakerInput = {
  meetingId: string
  speakerId: string
  participant: { name: string; email?: string }
  aliases: string[]
  embedding?: number[]
  embeddingModel?: string
}

export type MeetingSummary = {
  overview: string
  decisions: string[]
  actionItems: ActionItem[]
}

export type MeetingContext = {
  id: string
  name: string
  description?: string
  color?: string
  kind?: "room" | "project" | "client" | "topic"
  createdAt: string
}

export type MeetingParticipant = {
  id: string
  meetingId: string
  name: string
  email?: string
  role: "organizer" | "attendee" | "speaker" | "unknown"
  source: "calendar" | "transcript" | "manual" | "meet" | "drive"
  attendanceStatus: "accepted" | "declined" | "tentative" | "needs_action" | "unknown"
  speakerLabel?: string
  confidence?: number
  createdAt: string
  updatedAt: string
}

export type MeetingShare = {
  id: string
  meetingId: string
  token: string
  visibility: "public"
  revoked: boolean
  expiresAt?: string
  passwordHash?: string
  includedSections: string[]
  createdBy?: string
  createdAt: string
  updatedAt: string
  /**
   * M5: `meeting` (default) or `clip`. A clip token never resolves as a
   * meeting share and never makes the meeting link-visible.
   */
  scope?: "meeting" | "clip"
  clipId?: string
}

export type ExportRecord = {
  id: string
  meetingId: string
  format: "pdf" | "markdown" | "docx" | "notion"
  status: "created" | "queued" | "sent" | "failed"
  metadata: Record<string, unknown>
  createdAt: string
}

export type CreateContextInput = {
  name: string
  description?: string
}

export type SuggestedAgentRun = {
  id: string
  meetingId: string
  target: "realizeos" | "n8n" | "mcp" | "webhook"
  payload: Record<string, unknown>
  response?: Record<string, unknown>
  status: "suggested" | "queued" | "sent" | "failed"
  lastError?: string
  createdAt: string
}

/** `original` = captured/uploaded media; `playback` = derived rendition (M4). */
export type MediaAssetKind = "original" | "playback"

export type MediaAsset = {
  id: string
  meetingId: string
  storageKey: string
  filename?: string
  contentType: string
  sizeBytes: number
  retention: "audio" | "video"
  source?: string
  sourceFileId?: string
  checksumSha256?: string
  metadata?: Record<string, unknown>
  /** M4: `original` unless this is a derived playback rendition. */
  kind: MediaAssetKind
  /** M4: original asset a playback rendition was derived from. */
  derivedFromAssetId?: string
  /** M4: probed duration (ffprobe at prepare time). */
  durationMs?: number
  /** M4: waveform peaks JSON object key (on the original). */
  peaksStorageKey?: string
  preparedAt?: string
  prepareError?: string
  createdAt: string
}

/** Fields written by media preparation (M4). `null` clears a field. */
export type MediaAssetPreparationPatch = {
  durationMs?: number | null
  peaksStorageKey?: string | null
  preparedAt?: string | null
  prepareError?: string | null
}

export type MeetArtifact = {
  id: string
  conferenceRecordId: string
  conferenceRecordName: string
  artifactType: "recording" | "transcript" | "smart_notes"
  artifactName: string
  state?: string
  driveFileId?: string
  driveFileName?: string
  documentName?: string
  startTime?: string
  endTime?: string
}

export type MeetConferenceRecord = {
  id: string
  conferenceRecordName: string
  meetingId?: string
  calendarEventId?: string
  spaceName?: string
  startTime?: string
  endTime?: string
  expireTime?: string
  artifacts: MeetArtifact[]
}

export type JobStatus = "queued" | "active" | "completed" | "failed"

export type JobRecord = {
  id: string
  name: string
  status: JobStatus
  meetingId?: string
  payload: Record<string, unknown>
  result: Record<string, unknown>
  error?: string
  attempts: number
  maxAttempts: number
  retryOfJobId?: string
  startedAt?: string
  completedAt?: string
  retryable?: boolean
  createdAt: string
  updatedAt: string
}

export type AiRunRecord = {
  id: string
  meetingId: string
  provider: string
  task: string
  status: "queued" | "running" | "completed" | "failed"
  metadata: Record<string, unknown>
  model?: string
  latencyMs?: number
  confidence?: number
  startedAt: string
  completedAt?: string
  error?: string
}

export type MeetingQualityWarning = {
  code:
    | "smart_notes_only"
    | "transcription_fallback"
    | "weak_transcript_confidence"
    | "no_speaker_diarization"
    | "task_missing_owner_or_due_date"
    | "summary_language_mismatch"
  severity: "info" | "warning"
  title: string
  detail: string
}

/**
 * `createMeetingIfAbsent` hit an existing meeting with the same external id
 * that the caller cannot see. Callers must answer with a generic conflict
 * that reveals nothing about that meeting.
 */
export class MeetingExternalIdConflictError extends Error {
  constructor() {
    super("External id is already used by another meeting")
    this.name = "MeetingExternalIdConflictError"
  }
}

/** Who can see a meeting (M2). */
export type MeetingVisibility = "private" | "workspace" | "link"

/**
 * Data-access scope (M2). Every repository built for a request carries one;
 * see lib/meetings/visibility.ts for the visibility rules it implies.
 */
export type RepoScope =
  | {
      kind: "member"
      workspaceId: string
      userId: string
      email: string
      role: "owner" | "admin" | "member" | "viewer"
    }
  | { kind: "api_key"; workspaceId: string; ownerUserId?: string }
  | { kind: "system"; workspaceId: string }

export type MeetingRecord = {
  id: string
  title: string
  source: MeetingSource
  language: string
  status: MeetingStatus
  retention: "audio" | "video"
  startedAt: string
  participants: string[]
  participantDetails?: MeetingParticipant[]
  isFavorite?: boolean
  summary?: MeetingSummary
  transcript?: TranscriptSegment[]
  tags?: MeetingTag[]
  languageMetadata?: MeetingLanguageMetadata
  contexts?: MeetingContext[]
  intelligence?: MeetingIntelligence
  suggestedAgentRuns?: SuggestedAgentRun[]
  mediaAssets?: MediaAsset[]
  meetConferenceRecords?: MeetConferenceRecord[]
  aiRuns?: AiRunRecord[]
  qualityWarnings?: MeetingQualityWarning[]
  /** Diarized speakers (M3). */
  speakers?: MeetingSpeaker[]
  externalSource?: string
  externalId?: string
  workspaceId?: string
  ownerUserId?: string
  visibility?: MeetingVisibility
  /** Denormalized duration: media, else max(segment end) (M4). */
  durationMs?: number
  /** Segment count without loading the transcript (M4). */
  transcriptSegmentCount?: number
  /** `meetings.transcript_version` (M4). */
  transcriptVersion?: number
  /** Latest manual segment edit (M4). */
  transcriptEditedAt?: string
  /** Segments with `source='edited'` (M4). */
  editedSegmentCount?: number
  /** `meetings.template_key`: per-meeting summary template (M5). */
  templateKey?: string
  /** Where the title came from (M5); AI titles never overwrite `user`. */
  titleSource?: MeetingTitleSource
}

/**
 * Lightweight meeting row for the inbox list (M4): no transcript, words,
 * summary, intelligence or speakers.
 */
export type MeetingListItem = Omit<
  MeetingRecord,
  | "transcript"
  | "intelligence"
  | "aiRuns"
  | "suggestedAgentRuns"
  | "meetConferenceRecords"
  | "speakers"
  | "summary"
> & {
  durationMs?: number
  transcriptSegmentCount: number
  actionItemCount: number
  hasMedia: boolean
}

/**
 * Lightweight list item from a meeting record: drops the transcript, summary,
 * intelligence, speakers, AI/agent runs and Meet records, and media metadata.
 */
export function toMeetingListItem(meeting: MeetingRecord): MeetingListItem {
  const {
    transcript,
    intelligence,
    aiRuns,
    suggestedAgentRuns,
    meetConferenceRecords,
    speakers,
    summary,
    ...rest
  } = meeting

  void intelligence
  void aiRuns
  void suggestedAgentRuns
  void meetConferenceRecords
  void speakers

  return {
    ...rest,
    mediaAssets: meeting.mediaAssets?.map((asset) => {
      const { metadata, ...withoutMetadata } = asset

      void metadata
      return withoutMetadata
    }),
    transcriptSegmentCount: meeting.transcriptSegmentCount ?? transcript?.length ?? 0,
    actionItemCount: summary?.actionItems.length ?? 0,
    hasMedia: (meeting.mediaAssets?.length ?? 0) > 0,
  }
}

export type GetMeetingOptions = {
  /**
   * M4: include transcript segments (default true for internal callers; the
   * detail API passes false and reads `/transcript` separately).
   */
  includeTranscript?: boolean
}

export type MeetingListSortMode = "smart" | "recent" | "oldest" | "title" | "status"

export type MeetingListStatusFilter =
  | "all"
  | "usable"
  | "upcoming"
  | "processing"
  | "favorites"
  | MeetingStatus

export type MeetingListOptions = {
  limit?: number
  offset?: number
  query?: string
  status?: MeetingListStatusFilter | string
  sort?: MeetingListSortMode
}

export type MeetingListPage = {
  meetings: MeetingListItem[]
  page: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
}

export type CreateMeetingInput = {
  title: string
  source: MeetingSource
  language: string
  startedAt: string
  participants?: string[]
  externalSource?: string
  externalId?: string
  ownerUserId?: string
  visibility?: MeetingVisibility
}

export type MeetingAnswer = {
  answer: string
  citations: Array<{
    meetingId: string
    segmentId: string
    startMs: number
  }>
}

export type MeetingRepository = {
  listMeetings: (options?: MeetingListOptions) => Promise<MeetingRecord[]>
  listMeetingsPage: (options?: MeetingListOptions) => Promise<MeetingListPage>
  getMeeting: (id: string, options?: GetMeetingOptions) => Promise<MeetingRecord | undefined>
  createMeeting: (input: CreateMeetingInput) => Promise<MeetingRecord>
  updateMeetingStatus: (
    id: string,
    status: MeetingStatus
  ) => Promise<MeetingRecord>
  createMediaAsset: (input: {
    meetingId: string
    storageKey: string
    filename?: string
    contentType: string
    sizeBytes: number
    retention?: "audio" | "video"
    source?: string
    sourceFileId?: string
    checksumSha256?: string
    metadata?: Record<string, unknown>
    /** M4: defaults to `original`. */
    kind?: MediaAssetKind
    derivedFromAssetId?: string
    durationMs?: number
  }) => Promise<MediaAsset>
  findMediaAssetBySourceFile?: (
    source: string,
    sourceFileId: string,
    options?: { meetingId?: string }
  ) => Promise<MediaAsset | undefined>
  findMeetingByExternalId: (
    source: string,
    externalId: string
  ) => Promise<MeetingRecord | undefined>
  createMeetingIfAbsent: (
    input: CreateMeetingInput & { externalSource: string; externalId: string }
  ) => Promise<{ meeting: MeetingRecord; created: boolean }>
  /** Hard-deletes a meeting only when it has no transcript and no summary. */
  discardMeeting: (id: string) => Promise<boolean>
  replaceTranscriptSegments: (
    meetingId: string,
    segments: TranscriptSegment[]
  ) => Promise<TranscriptSegment[]>
  /**
   * Replaces segments (with words) and upserts speakers in one transaction
   * (M3). Never creates meeting_participants for speaker labels.
   */
  replaceTranscript: (
    meetingId: string,
    input: ReplaceTranscriptInput,
    options?: ReplaceTranscriptOptions
  ) => Promise<{ segments: TranscriptSegment[]; speakers: MeetingSpeaker[] }>
  listMeetingSpeakers: (
    meetingId: string,
    options?: ListMeetingSpeakersOptions
  ) => Promise<MeetingSpeaker[]>
  updateMeetingSpeaker: (
    meetingId: string,
    speakerId: string,
    patch: MeetingSpeakerPatch
  ) => Promise<MeetingSpeaker>
  /** Moves the source speaker's segments to the target and deletes the source. */
  mergeMeetingSpeakers: (
    meetingId: string,
    sourceId: string,
    targetId: string
  ) => Promise<MeetingSpeaker>
  setSpeakerSuggestions: (
    meetingId: string,
    items: SpeakerSuggestionUpdate[]
  ) => Promise<MeetingSpeaker[]>
  listSpeakerProfiles: () => Promise<SpeakerProfile[]>
  recordConfirmedSpeaker: (input: RecordConfirmedSpeakerInput) => Promise<SpeakerProfile>
  /** Transcript with speakers and version (M4); undefined when invisible. */
  getMeetingTranscript: (meetingId: string) => Promise<MeetingTranscript | undefined>
  /** `meetings.transcript_version` (M4); undefined when invisible. */
  getTranscriptVersion: (meetingId: string) => Promise<number | undefined>
  /**
   * Edits one segment (M4): stores a revision of the prior state, realigns
   * words, bumps segment revision and transcript version. Throws
   * SegmentNotFoundError / TranscriptConflictError.
   */
  updateTranscriptSegment: (
    meetingId: string,
    segmentId: string,
    patch: SegmentPatch
  ) => Promise<SegmentMutationResult>
  /** Restores the latest non-reverted revision of a segment (M4). */
  undoTranscriptSegment: (
    meetingId: string,
    segmentId: string,
    options: { expectedRevision: number; actorUserId?: string }
  ) => Promise<SegmentMutationResult>
  listTranscriptRevisions: (
    meetingId: string,
    segmentId: string
  ) => Promise<TranscriptRevision[]>
  /**
   * M4: renames a visible meeting (a user rename: M5 sets
   * `title_source='user'`, so AI titles never overwrite it).
   */
  renameMeeting: (id: string, title: string) => Promise<MeetingRecord>
  /**
   * M4: hard-deletes a visible meeting (rows cascade) and returns the object
   * keys (media, derived renditions, peaks) to delete afterwards; undefined
   * when the meeting is not visible.
   */
  deleteMeeting: (id: string) => Promise<DeletedMeeting | undefined>
  updateMediaAssetPreparation: (
    assetId: string,
    patch: MediaAssetPreparationPatch
  ) => Promise<MediaAsset>
  /** M4: sets `meetings.duration_ms` (`transcript` never overrides media). */
  setMeetingDurationMs: (
    meetingId: string,
    durationMs: number,
    source: "media" | "transcript"
  ) => Promise<void>
  upsertMeetingIntelligence: (
    meetingId: string,
    intelligence: MeetingIntelligence,
    provider?: string,
    model?: string
  ) => Promise<MeetingIntelligence>
  updateActionItem: (id: string, patch: ActionItemPatch) => Promise<ActionItem>
  /** M5: user-created item (origin `user`, `edited_by_user`). */
  createActionItem: (
    meetingId: string,
    input: CreateActionItemInput,
    actor: ActionItemActor
  ) => Promise<ActionItem>
  /** M5: true when a visible item was deleted. */
  deleteActionItem: (id: string) => Promise<boolean>
  /** M5: per-meeting summary template; null clears it. */
  setMeetingTemplate: (id: string, templateKey: string | null) => Promise<MeetingRecord>
  /** M5: AI title; a no-op (false) when `title_source='user'`. */
  applyAiTitle: (id: string, title: string) => Promise<boolean>
  /** M5: sets the title and its source. */
  setMeetingTitle: (
    id: string,
    title: string,
    source: MeetingTitleSource
  ) => Promise<MeetingRecord>
  createJob: (input: {
    id?: string
    name: string
    meetingId?: string
    payload?: Record<string, unknown>
    status?: JobStatus
    retryOfJobId?: string
    maxAttempts?: number
  }) => Promise<JobRecord>
  updateJob: (
    id: string,
    patch: Partial<
      Pick<
        JobRecord,
        "status" | "result" | "error" | "attempts" | "startedAt" | "completedAt"
      >
    >
  ) => Promise<JobRecord>
  getJob: (id: string) => Promise<JobRecord | undefined>
  listJobs: (filters?: { meetingId?: string; status?: JobStatus }) => Promise<JobRecord[]>
  searchMeetings: (
    query: string,
    options?: { limit?: number }
  ) => Promise<MeetingRecord[]>
  askMeetingMemory: (
    meetingId: string,
    question: string
  ) => Promise<MeetingAnswer>
  getMeetingIntelligence: (
    meetingId: string
  ) => Promise<MeetingIntelligence | undefined>
  runMeetingIntelligence: (meetingId: string) => Promise<MeetingIntelligence>
  listContexts: () => Promise<MeetingContext[]>
  createContext: (input: CreateContextInput) => Promise<MeetingContext>
  linkMeetingContext: (
    meetingId: string,
    contextId: string
  ) => Promise<MeetingRecord>
  listRooms: () => Promise<Array<MeetingContext & { meetingCount: number }>>
  listMeetingsByContext: (contextId: string) => Promise<MeetingRecord[]>
  updateMeetingTags: (meetingId: string, tags: string[]) => Promise<MeetingRecord>
  updateMeetingFavorite: (meetingId: string, favorite: boolean) => Promise<MeetingRecord>
  createMeetingShare: (input: {
    meetingId: string
    createdBy?: string
    includedSections?: string[]
    expiresAt?: string
    password?: string
  }) => Promise<MeetingShare>
  updateMeetingShare: (
    meetingId: string,
    patch: { revoked?: boolean; regenerate?: boolean; includedSections?: string[] }
  ) => Promise<MeetingShare>
  getShareByToken: (
    token: string
  ) => Promise<{ share: MeetingShare; meeting: MeetingRecord } | undefined>
  /**
   * Sets who can see a meeting. Leaving `link` revokes every active share in
   * the same transaction; creating a share sets `link`.
   */
  updateMeetingVisibility: (
    meetingId: string,
    visibility: MeetingVisibility
  ) => Promise<MeetingRecord>
  listMeetingParticipants: (meetingId: string) => Promise<MeetingParticipant[]>
  updateMeetingParticipant: (
    participantId: string,
    patch: Partial<Pick<MeetingParticipant, "name" | "email" | "role" | "attendanceStatus" | "speakerLabel">>
  ) => Promise<MeetingParticipant>
  assignSpeakerToParticipant: (
    meetingId: string,
    speakerLabel: string,
    participantId: string
  ) => Promise<MeetingParticipant>
  createExportRecord: (input: {
    meetingId: string
    format: ExportRecord["format"]
    metadata?: Record<string, unknown>
  }) => Promise<ExportRecord>
  approveAgentRun: (id: string) => Promise<SuggestedAgentRun>
  createSuggestedAgentRun: (input: {
    meetingId: string
    target: SuggestedAgentRun["target"]
    payload: Record<string, unknown>
  }) => Promise<SuggestedAgentRun>
}

function normalize(value: string): string {
  return value.toLowerCase()
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function publicProfile(profile: StoredSpeakerProfile): SpeakerProfile {
  const result: SpeakerProfile = {
    id: profile.id,
    workspaceId: profile.workspaceId,
    displayName: profile.displayName,
    email: profile.email,
    aliases: [...profile.aliases],
    confirmedCount: profile.confirmedCount,
  }

  if (profile.voiceEmbedding) {
    result.voiceEmbedding = [...profile.voiceEmbedding]
    result.embeddingModel = profile.embeddingModel
  }
  return result
}

function normalizeListLimit(value?: number) {
  if (!value || !Number.isFinite(value)) return 50

  return Math.max(1, Math.min(Math.trunc(value), 100))
}

function normalizeListOffset(value?: number) {
  if (!value || !Number.isFinite(value)) return 0

  return Math.max(0, Math.trunc(value))
}

function meetingMatchesStatus(meeting: MeetingRecord, status?: string) {
  if (!status || status === "all") return true
  if (status === "usable") {
    return [
      "completed",
      "indexing",
      "summarizing",
      "transcribing",
      "media_uploaded",
      "failed",
    ].includes(meeting.status)
  }
  if (status === "upcoming") {
    return meeting.status === "scheduled" && new Date(meeting.startedAt).getTime() > Date.now()
  }
  if (status === "processing") {
    return ["indexing", "summarizing", "transcribing", "media_uploaded"].includes(
      meeting.status
    )
  }
  if (status === "favorites") {
    return meeting.isFavorite === true
  }

  return meeting.status === status
}

function meetingMatchesQuery(meeting: MeetingRecord, query?: string) {
  const needle = query?.trim().toLowerCase()

  if (!needle) return true

  const searchable = [
    meeting.title,
    meeting.source,
    meeting.language,
    meeting.summary?.overview,
    ...(meeting.summary?.decisions ?? []),
    ...(meeting.summary?.actionItems.map((item) => item.title) ?? []),
    ...(meeting.tags ?? []),
    ...(meeting.contexts?.map((context) => context.name) ?? []),
    ...(meeting.transcript?.map((segment) => segment.text) ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

  return searchable.includes(needle)
}

function sortMeetings(meetings: MeetingRecord[], mode: MeetingListSortMode = "smart") {
  const rank: Record<string, number> = {
    completed: 0,
    indexing: 1,
    summarizing: 1,
    transcribing: 1,
    media_uploaded: 2,
    media_found: 3,
    failed: 4,
    scheduled: 6,
    created: 7,
  }
  const now = Date.now()

  return [...meetings].sort((left, right) => {
    const leftTime = new Date(left.startedAt).getTime()
    const rightTime = new Date(right.startedAt).getTime()

    if (mode === "recent") return rightTime - leftTime
    if (mode === "oldest") return leftTime - rightTime
    if (mode === "title") return left.title.localeCompare(right.title)
    if (mode === "status") {
      const statusCompare = left.status.localeCompare(right.status)
      if (statusCompare !== 0) return statusCompare
      return rightTime - leftTime
    }

    const leftFuture = left.status === "scheduled" && leftTime > now
    const rightFuture = right.status === "scheduled" && rightTime > now
    const leftRank = leftFuture ? 8 : (rank[left.status] ?? 5)
    const rightRank = rightFuture ? 8 : (rank[right.status] ?? 5)

    if (leftRank !== rightRank) return leftRank - rightRank
    return rightTime - leftTime
  })
}

/**
 * Raised when an operation is not available to the repository's scope (for
 * example favorites without a signed-in member). `status` is the HTTP status
 * a route should answer with.
 */
export class MeetingScopeError extends Error {
  readonly status: 400 | 403

  constructor(message: string, status: 400 | 403 = 400) {
    super(message)
    this.name = "MeetingScopeError"
    this.status = status
  }
}

/** System scope of the legacy default workspace (pre-M2 behaviour). */
export const DEFAULT_SYSTEM_SCOPE: RepoScope = {
  kind: "system",
  workspaceId: DEFAULT_WORKSPACE_ID,
}

/**
 * Shared state behind in-memory repositories. Several scoped repositories
 * (one per request scope) read and write the same database, mirroring how
 * scoped Postgres repositories share one pool.
 */
export type InMemoryMeetingDatabase = {
  meetings: Map<string, MeetingRecord>
  contexts: Map<string, MeetingContext>
  contextWorkspaces: Map<string, string>
  jobs: Map<string, JobRecord>
  jobWorkspaces: Map<string, string>
  shares: Map<string, MeetingShare>
  participants: Map<string, MeetingParticipant>
  exportRecords: Map<string, ExportRecord>
  suggestedRuns: Map<string, SuggestedAgentRun>
  /** `${userId}\u0000${meetingId}` */
  favorites: Set<string>
  /** Diarized speakers (M3), keyed by speaker id. */
  speakers: Map<string, StoredSpeaker>
  /** Workspace speaker memory (M3), keyed by profile id. */
  speakerProfiles: Map<string, StoredSpeakerProfile>
  /** Prior states of edited segments (M4), keyed by revision id. */
  transcriptRevisions: Map<string, StoredTranscriptRevision>
}

export type StoredTranscriptRevision = TranscriptRevision & { workspaceId: string }

/** A `speakers` row; `displayName` is the stored display name only. */
export type StoredSpeaker = MeetingSpeaker & {
  workspaceId: string
  confirmedByUserId?: string
}

export type StoredSpeakerProfile = SpeakerProfile & {
  embeddingSamples: number
  lastMeetingId?: string
  lastConfirmedAt?: string
}

export function createInMemoryMeetingDatabase(
  initialMeetings: MeetingRecord[] = []
): InMemoryMeetingDatabase {
  return {
    meetings: new Map(
      initialMeetings.map((meeting) => [meeting.id, { isFavorite: false, ...meeting }])
    ),
    contexts: new Map(),
    contextWorkspaces: new Map(),
    jobs: new Map(),
    jobWorkspaces: new Map(),
    shares: new Map(),
    participants: new Map(),
    exportRecords: new Map(),
    suggestedRuns: new Map(),
    favorites: new Set(),
    speakers: new Map(),
    speakerProfiles: new Map(),
    transcriptRevisions: new Map(),
  }
}

/** True for meeting-scope shares; clip tokens never open a meeting (M5). */
export function isMeetingScopeShare(share: Pick<MeetingShare, "scope">): boolean {
  return (share.scope ?? "meeting") === "meeting"
}

function favoriteKey(userId: string, meetingId: string) {
  return `${userId}\u0000${meetingId}`
}

function meetingWorkspaceId(meeting: MeetingRecord) {
  return meeting.workspaceId ?? DEFAULT_WORKSPACE_ID
}

/**
 * In-memory repository restricted to `scope` (defaults to the system scope
 * of the default workspace). Mirrors the Postgres repository's M2 semantics:
 * invisible or foreign meetings behave exactly like missing ones.
 */
export function createInMemoryMeetingRepository(
  source: MeetingRecord[] | InMemoryMeetingDatabase = [],
  scope: RepoScope = DEFAULT_SYSTEM_SCOPE
): MeetingRepository {
  const db = Array.isArray(source) ? createInMemoryMeetingDatabase(source) : source
  const {
    meetings,
    contexts,
    contextWorkspaces,
    jobs,
    jobWorkspaces,
    shares,
    participants,
    exportRecords,
    suggestedRuns,
    favorites,
    speakers,
    speakerProfiles,
    transcriptRevisions,
  } = db
  const workspaceId = scope.workspaceId
  const favoriteUserId = scope.kind === "member" ? scope.userId : undefined
  const defaultOwnerUserId =
    scope.kind === "member"
      ? scope.userId
      : scope.kind === "api_key"
        ? scope.ownerUserId
        : undefined

  function ensureParticipants(meeting: MeetingRecord): MeetingParticipant[] {
    const existing = [...participants.values()].filter(
      (participant) => participant.meetingId === meeting.id
    )

    if (existing.length) return existing

    const now = new Date().toISOString()
    const sourceParticipants = meeting.participants.length
      ? meeting.participants.map((participant, index) => ({
          name: participant,
          role: index === 0 ? ("organizer" as const) : ("attendee" as const),
          source: "calendar" as const,
        }))
      : [
          // Diarized (M3) segments never create participants for labels.
          ...new Set(
            (meeting.transcript ?? [])
              .filter((segment) => !segment.speakerId)
              .map((segment) => segment.speaker)
          ),
        ].map((speaker) => ({
          name: speaker,
          role: "speaker" as const,
          source: "transcript" as const,
        }))

    return sourceParticipants.map((participant) => {
      const participantName = participant.name
      const email = participantName.includes("@") ? participantName : undefined
      const name = email ? participantName.split("@")[0] : participantName
      const record: MeetingParticipant = {
        id: createId("participant"),
        meetingId: meeting.id,
        name,
        email,
        role: participant.role,
        source: participant.source,
        attendanceStatus: "unknown",
        confidence: 0.6,
        speakerLabel: participant.source === "transcript" ? participant.name : undefined,
        createdAt: now,
        updatedAt: now,
      }

      participants.set(record.id, record)
      return record
    })
  }

  function isVisible(meeting: MeetingRecord): boolean {
    if (meetingWorkspaceId(meeting) !== workspaceId) return false
    if (scope.kind !== "member" || (meeting.visibility ?? "workspace") !== "private") {
      return canViewMeeting(scope, meeting)
    }

    return canViewMeeting(
      scope,
      meeting,
      ensureParticipants(meeting).map((participant) => participant.email)
    )
  }

  /** The stored meeting when this scope can see it. */
  function visibleMeeting(id: string): MeetingRecord | undefined {
    const meeting = meetings.get(id)

    return meeting && isVisible(meeting) ? meeting : undefined
  }

  function requireVisibleMeeting(id: string): MeetingRecord {
    const meeting = visibleMeeting(id)

    if (!meeting) throw new Error(`Meeting not found: ${id}`)
    return meeting
  }

  function visibleMeetings(): MeetingRecord[] {
    return [...meetings.values()].filter(isVisible)
  }

  function meetingSpeakerRows(meetingId: string): StoredSpeaker[] {
    return [...speakers.values()]
      .filter((speaker) => speaker.meetingId === meetingId)
      .sort(
        (a, b) =>
          (a.firstStartMs ?? Number.MAX_SAFE_INTEGER) -
            (b.firstStartMs ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label)
      )
  }

  /** Public view of a speaker row: name = participant name ?? display name. */
  function resolveSpeaker(row: StoredSpeaker, includeEmbeddings = false): MeetingSpeaker {
    const participant = row.participantId ? participants.get(row.participantId) : undefined
    const participantName =
      participant && participant.meetingId === row.meetingId ? participant.name : undefined
    const resolved: MeetingSpeaker = {
      id: row.id,
      meetingId: row.meetingId,
      label: row.label,
      displayName: participantName ?? row.displayName,
      participantId: row.participantId,
      profileId: row.profileId,
      mappingStatus: row.mappingStatus,
      suggestion: row.suggestion,
      source: row.source,
      talkTimeMs: row.talkTimeMs,
      wordCount: row.wordCount,
      segmentCount: row.segmentCount,
      firstStartMs: row.firstStartMs,
      confirmedAt: row.confirmedAt,
    }

    if (includeEmbeddings && row.embedding) {
      resolved.embedding = row.embedding
      resolved.embeddingModel = row.embeddingModel
    }
    return resolved
  }

  function existingSpeakerRows(meetingId: string): ExistingSpeakerRow[] {
    return meetingSpeakerRows(meetingId).map((row) => ({
      id: row.id,
      label: row.label,
      source: row.source,
      mappingStatus: row.mappingStatus,
      resolvedName: resolveSpeaker(row).displayName ?? row.label,
    }))
  }

  function requireMeetingSpeaker(meetingId: string, speakerId: string): StoredSpeaker {
    const row = speakers.get(speakerId)

    if (!row || row.meetingId !== meetingId) {
      throw new Error(`Speaker not found: ${speakerId}`)
    }
    return row
  }

  function requireMeetingParticipant(meetingId: string, participantId: string) {
    const participant = participants.get(participantId)

    if (!participant || participant.meetingId !== meetingId) {
      throw new Error(`Participant not found: ${participantId}`)
    }
    return participant
  }

  function listFullMeetingsPage(options: MeetingListOptions = {}): {
    meetings: MeetingRecord[]
    page: MeetingListPage["page"]
  } {
    const limit = normalizeListLimit(options.limit)
    const offset = normalizeListOffset(options.offset)
    const filtered = visibleMeetings()
      .map((meeting) => hydrate(meeting))
      .filter((meeting) => meetingMatchesStatus(meeting, options.status))
      .filter((meeting) => meetingMatchesQuery(meeting, options.query))
    const sorted = sortMeetings(filtered, options.sort)
    const pageMeetings = sorted.slice(offset, offset + limit)

    return {
      meetings: pageMeetings,
      page: {
        limit,
        offset,
        total: sorted.length,
        hasMore: offset + pageMeetings.length < sorted.length,
      },
    }
  }

  function writeTranscript(
    meeting: MeetingRecord,
    input: ReplaceTranscriptInput,
    preserveDiarizedMappings = false,
    preserveEdited = false
  ): { segments: TranscriptSegment[]; speakers: MeetingSpeaker[] } {
    const edited = preserveEdited
      ? (meeting.transcript ?? []).filter((segment) => segment.source === "edited")
      : []
    const { segments: incoming, preservedIds } = preserveEditedSegments(input.segments, edited)
    // Re-inserted rows start fresh (mirrors Postgres defaults); kept rows keep their edit state.
    const plan = planTranscriptReplacement({
      existing: existingSpeakerRows(meeting.id),
      segments: incoming.map((segment) => {
        if (preservedIds.has(segment.id)) return segment

        const { revision, editedAt, ...fresh } = segment

        void revision
        void editedAt
        return fresh
      }),
      speakers: input.speakers,
      createId,
      preserveDiarizedMappings,
    })

    for (const id of plan.deleteIds) speakers.delete(id)
    for (const upsert of plan.upserts) {
      const previous = upsert.isNew ? undefined : speakers.get(upsert.id)
      const base: StoredSpeaker = previous ?? {
        id: upsert.id,
        meetingId: meeting.id,
        label: upsert.label,
        mappingStatus: "unmapped",
        source: upsert.source,
        talkTimeMs: 0,
        wordCount: 0,
        segmentCount: 0,
        workspaceId: meetingWorkspaceId(meeting),
      }
      const next: StoredSpeaker = {
        ...base,
        workspaceId: meetingWorkspaceId(meeting),
        source: upsert.source,
        talkTimeMs: upsert.talkTimeMs,
        wordCount: upsert.wordCount,
        segmentCount: upsert.segmentCount,
        firstStartMs: upsert.firstStartMs,
        embedding: upsert.embedding ?? base.embedding,
        embeddingModel: upsert.embedding ? upsert.embeddingModel : base.embeddingModel,
      }

      if (upsert.resetMapping) {
        next.mappingStatus = "unmapped"
        delete next.participantId
        delete next.profileId
        delete next.displayName
        delete next.suggestion
        delete next.confirmedAt
        delete next.confirmedByUserId
      }
      speakers.set(upsert.id, next)
    }

    // Revisions cascade with their (deleted and re-inserted) segment rows.
    for (const [id, revision] of transcriptRevisions) {
      if (revision.meetingId === meeting.id && !preservedIds.has(revision.segmentId)) {
        transcriptRevisions.delete(id)
      }
    }

    const mediaDuration = (meeting.mediaAssets ?? []).some((asset) => asset.durationMs)
    const transcriptEnd = plan.segments.reduce((end, segment) => Math.max(end, segment.endMs), 0)

    meetings.set(meeting.id, {
      ...meeting,
      transcript: plan.segments,
      transcriptVersion: (meeting.transcriptVersion ?? 0) + 1,
      ...(!mediaDuration && transcriptEnd > 0 ? { durationMs: Math.round(transcriptEnd) } : {}),
    })

    return {
      segments: plan.segments,
      speakers: meetingSpeakerRows(meeting.id).map((row) => resolveSpeaker(row)),
    }
  }

  function bumpTranscriptVersion(meetingId: string): number {
    const meeting = meetings.get(meetingId)

    if (!meeting) return 0

    const version = (meeting.transcriptVersion ?? 0) + 1

    meetings.set(meetingId, { ...meeting, transcriptVersion: version })
    return version
  }

  /** Public segment: speaker name resolved through its speaker row. */
  function resolveSegment(segment: TranscriptSegment): TranscriptSegment {
    const row = segment.speakerId ? speakers.get(segment.speakerId) : undefined
    const speaker = row ? resolveSpeaker(row) : undefined

    return speaker ? { ...segment, speaker: speaker.displayName ?? speaker.label } : { ...segment }
  }

  /** Talk time / words / segments / first start of every speaker, from segments. */
  function recomputeSpeakerStats(meetingId: string, transcript: readonly TranscriptSegment[]) {
    for (const row of meetingSpeakerRows(meetingId)) {
      const own = transcript.filter((segment) => segment.speakerId === row.id)

      speakers.set(row.id, {
        ...row,
        talkTimeMs: own.reduce(
          (sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs),
          0
        ),
        wordCount: own.reduce((sum, segment) => sum + segmentWordCount(segment), 0),
        segmentCount: own.length,
        firstStartMs: own.length ? Math.min(...own.map((segment) => segment.startMs)) : undefined,
      })
    }
  }

  function withTurnIndexes(transcript: TranscriptSegment[]): TranscriptSegment[] {
    const turns = computeTurnIndexes(transcript, (segment) => segment.speakerId ?? segment.speaker)

    return transcript.map((segment, index) => ({ ...segment, turnIndex: turns[index] }))
  }

  function storeRevision(
    meetingId: string,
    segment: TranscriptSegment,
    actorUserId: string | undefined
  ) {
    const revision: StoredTranscriptRevision = {
      id: createId("rev"),
      workspaceId,
      meetingId,
      segmentId: segment.id,
      revision: segment.revision ?? 0,
      text: segment.text,
      words: segment.words?.map((word) => ({ ...word })),
      speakerId: segment.speakerId,
      source: segment.source ?? "asr",
      createdByUserId: actorUserId,
      createdAt: new Date().toISOString(),
    }

    transcriptRevisions.set(revision.id, revision)
  }

  function segmentRevisions(meetingId: string, segmentId: string): StoredTranscriptRevision[] {
    return [...transcriptRevisions.values()]
      .filter(
        (revision) =>
          revision.workspaceId === workspaceId &&
          revision.meetingId === meetingId &&
          revision.segmentId === segmentId
      )
      .sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt))
  }

  function pruneRevisions(meetingId: string, segmentIds: readonly string[]) {
    const keep = transcriptRevisionsKeep()

    for (const segmentId of segmentIds) {
      for (const revision of segmentRevisions(meetingId, segmentId).slice(keep)) {
        transcriptRevisions.delete(revision.id)
      }
    }
  }

  function requireEditableSegment(meetingId: string, segmentId: string, expectedRevision: number) {
    const meeting = visibleMeeting(meetingId)
    const transcript = meeting?.transcript ?? []
    const current = transcript.find((segment) => segment.id === segmentId)

    if (!meeting || !current) throw new SegmentNotFoundError(segmentId)
    if ((current.revision ?? 0) !== expectedRevision) {
      throw new TranscriptConflictError(resolveSegment(current))
    }

    return { meeting, transcript, current }
  }

  function mutationResult(
    meetingId: string,
    transcript: readonly TranscriptSegment[],
    segmentId: string,
    speakerChanged: boolean,
    version: number
  ): SegmentMutationResult {
    const segment = transcript.find((candidate) => candidate.id === segmentId) as TranscriptSegment

    return {
      segment: resolveSegment(segment),
      ...(speakerChanged
        ? { speakers: meetingSpeakerRows(meetingId).map((row) => resolveSpeaker(row)) }
        : {}),
      version,
    }
  }

  function hydrate(meeting: MeetingRecord, includeTranscript = true): MeetingRecord {
    const speakerRows = meetingSpeakerRows(meeting.id)
    const segments = meeting.transcript ?? []
    const edited = segments.filter((segment) => segment.source === "edited")
    const editedAt = edited
      .map((segment) => segment.editedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
    const hydrated: MeetingRecord = {
      ...meeting,
      isFavorite: favoriteUserId
        ? favorites.has(favoriteKey(favoriteUserId, meeting.id))
        : false,
      participantDetails: ensureParticipants(meeting),
      transcriptSegmentCount: segments.length,
      transcriptVersion: meeting.transcriptVersion ?? 0,
      editedSegmentCount: edited.length,
      transcriptEditedAt: editedAt[editedAt.length - 1],
    }

    if (!includeTranscript) {
      delete hydrated.transcript
      // Without segments: stored duration, media duration, else last segment end.
      const end = segments.reduce((max, segment) => Math.max(max, segment.endMs), 0)
      const durationMs =
        getMeetingDurationMs({ durationMs: meeting.durationMs, mediaAssets: meeting.mediaAssets }) ??
        (end > 0 ? end : undefined)

      if (durationMs !== undefined) hydrated.durationMs = durationMs
    }
    if (!speakerRows.length) return hydrated

    const resolved = new Map(speakerRows.map((row) => [row.id, resolveSpeaker(row)]))

    return {
      ...hydrated,
      speakers: [...resolved.values()],
      ...(includeTranscript
        ? {
            transcript: meeting.transcript?.map((segment) => {
              const speaker = segment.speakerId ? resolved.get(segment.speakerId) : undefined

              return speaker
                ? { ...segment, speaker: speaker.displayName ?? speaker.label }
                : segment
            }),
          }
        : {}),
    }
  }

  /** Workspace jobs; one linked to a meeting only while that meeting is visible. */
  function isScopedJob(job: JobRecord): boolean {
    return (
      jobWorkspaces.get(job.id) === workspaceId &&
      (!job.meetingId || Boolean(visibleMeeting(job.meetingId)))
    )
  }

  function scopedJob(id: string): JobRecord | undefined {
    const job = jobs.get(id)

    return job && isScopedJob(job) ? job : undefined
  }

  function scopedContext(id: string): MeetingContext | undefined {
    return contextWorkspaces.get(id) === workspaceId ? contexts.get(id) : undefined
  }

  /** Latest meeting-scope share (clip shares are Package C's and never count). */
  function latestShare(meetingId: string, activeOnly: boolean) {
    return [...shares.values()]
      .filter(
        (share) =>
          share.meetingId === meetingId &&
          isMeetingScopeShare(share) &&
          (!activeOnly || !share.revoked)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }

  /** Writes a meeting's action items to its summary and intelligence. */
  function writeActionItems(meeting: MeetingRecord, actionItems: ActionItem[]) {
    const current = meetings.get(meeting.id) ?? meeting

    meetings.set(meeting.id, {
      ...current,
      summary: {
        overview: current.summary?.overview ?? "",
        decisions: current.summary?.decisions ?? [],
        actionItems,
      },
      intelligence: current.intelligence
        ? {
            ...current.intelligence,
            actionItems: actionItems as MeetingIntelligence["actionItems"],
          }
        : undefined,
    })
  }

  function setLinkVisibility(meeting: MeetingRecord) {
    meetings.set(meeting.id, { ...meeting, visibility: "link" })
  }

  /** Deletes a meeting and its rows (mirrors the Postgres cascades). */
  function removeMeetingRows(id: string) {
    meetings.delete(id)
    for (const [participantId, participant] of participants) {
      if (participant.meetingId === id) participants.delete(participantId)
    }
    for (const [jobId, job] of jobs) {
      if (job.meetingId === id) jobs.set(jobId, { ...job, meetingId: undefined })
    }
    for (const key of favorites) {
      if (key.endsWith(`\u0000${id}`)) favorites.delete(key)
    }
    for (const [speakerId, speaker] of speakers) {
      if (speaker.meetingId === id) speakers.delete(speakerId)
    }
    for (const [shareId, share] of shares) {
      if (share.meetingId === id) shares.delete(shareId)
    }
    for (const [recordId, record] of exportRecords) {
      if (record.meetingId === id) exportRecords.delete(recordId)
    }
    for (const [runId, run] of suggestedRuns) {
      if (run.meetingId === id) suggestedRuns.delete(runId)
    }
    for (const [revisionId, revision] of transcriptRevisions) {
      if (revision.meetingId === id) transcriptRevisions.delete(revisionId)
    }
  }

  return {
    async findMeetingByExternalId(source, externalId) {
      for (const meeting of visibleMeetings()) {
        if (meeting.externalSource === source && meeting.externalId === externalId) {
          return hydrate(meeting)
        }
      }

      return undefined
    },

    async createMeetingIfAbsent(input) {
      // Uniqueness is per workspace (workspace_id, external_source, external_id).
      const conflicting = [...meetings.values()].find(
        (meeting) =>
          meetingWorkspaceId(meeting) === workspaceId &&
          meeting.externalSource === input.externalSource &&
          meeting.externalId === input.externalId
      )

      if (conflicting) {
        const existing = await this.findMeetingByExternalId(
          input.externalSource,
          input.externalId
        )

        if (!existing) throw new MeetingExternalIdConflictError()

        return { meeting: existing, created: false }
      }

      return { meeting: await this.createMeeting(input), created: true }
    },

    async discardMeeting(id) {
      const meeting = visibleMeeting(id)

      if (!meeting || meeting.transcript?.length || meeting.summary) return false

      removeMeetingRows(id)
      return true
    },

    async listMeetings(options?: MeetingListOptions): Promise<MeetingRecord[]> {
      return listFullMeetingsPage(options).meetings
    },

    async listMeetingsPage(options: MeetingListOptions = {}): Promise<MeetingListPage> {
      const { meetings: full, page } = listFullMeetingsPage(options)

      return { meetings: full.map(toMeetingListItem), page }
    },

    async getMeeting(id: string, options: GetMeetingOptions = {}) {
      const meeting = visibleMeeting(id)

      return meeting ? hydrate(meeting, options.includeTranscript !== false) : undefined
    },

    async createMeeting(input: CreateMeetingInput): Promise<MeetingRecord> {
      const meeting: MeetingRecord = {
        id: createId("meet"),
        title: input.title,
        source: input.source,
        language: input.language,
        status: "created",
        retention: "audio",
        startedAt: input.startedAt,
        participants: input.participants ?? [],
        isFavorite: false,
        externalSource: input.externalSource,
        externalId: input.externalId,
        workspaceId,
        ownerUserId: input.ownerUserId ?? defaultOwnerUserId,
        visibility: input.visibility ?? "workspace",
      }

      meetings.set(meeting.id, meeting)
      ensureParticipants(meeting)
      return hydrate(meeting)
    },

    async updateMeetingStatus(
      id: string,
      status: MeetingStatus
    ): Promise<MeetingRecord> {
      const meeting = requireVisibleMeeting(id)
      const updated = { ...meeting, status }

      meetings.set(id, updated)
      return hydrate(updated)
    },

    async createMediaAsset(input): Promise<MediaAsset> {
      const meeting = requireVisibleMeeting(input.meetingId)
      const asset: MediaAsset = {
        id: createId("asset"),
        meetingId: input.meetingId,
        storageKey: input.storageKey,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        retention: input.retention ?? "audio",
        source: input.source,
        sourceFileId: input.sourceFileId,
        checksumSha256: input.checksumSha256,
        metadata: input.metadata,
        kind: input.kind ?? "original",
        derivedFromAssetId: input.derivedFromAssetId,
        durationMs: input.durationMs,
        createdAt: new Date().toISOString(),
      }
      const updated: MeetingRecord = {
        ...meeting,
        mediaAssets: [...(meeting.mediaAssets ?? []), asset],
        // A derived playback rendition never changes the meeting status.
        ...(asset.kind === "original" ? { status: "media_uploaded" as const } : {}),
      }

      meetings.set(meeting.id, updated)
      return asset
    },

    async findMediaAssetBySourceFile(source, sourceFileId, options = {}) {
      for (const meeting of visibleMeetings()) {
        if (options.meetingId && meeting.id !== options.meetingId) continue

        const asset = meeting.mediaAssets?.find(
          (candidate) =>
            candidate.source === source &&
            candidate.sourceFileId === sourceFileId
        )

        if (asset) return asset
      }

      return undefined
    },

    async replaceTranscriptSegments(
      meetingId: string,
      segments: TranscriptSegment[]
    ): Promise<TranscriptSegment[]> {
      const meeting = requireVisibleMeeting(meetingId)

      // The same transcript re-written (cleanup): manual edits always win.
      writeTranscript(
        meeting,
        legacySegmentsToTranscript(existingSpeakerRows(meetingId), segments),
        true,
        true
      )
      return segments
    },

    async replaceTranscript(meetingId, input, options = {}) {
      // preserveEdited = the same transcript re-written (cleanup): it also keeps
      // confirmed/rejected diarized speaker mappings of surviving labels.
      const preserve = options.preserveEdited === true

      return writeTranscript(requireVisibleMeeting(meetingId), input, preserve, preserve)
    },

    async listMeetingSpeakers(meetingId, options = {}) {
      requireVisibleMeeting(meetingId)

      return meetingSpeakerRows(meetingId).map((row) =>
        resolveSpeaker(row, options.includeEmbeddings)
      )
    },

    async updateMeetingSpeaker(meetingId, speakerId, patch) {
      requireVisibleMeeting(meetingId)

      const row = requireMeetingSpeaker(meetingId, speakerId)

      if (patch.participantId) requireMeetingParticipant(meetingId, patch.participantId)
      if (patch.profileId) {
        const profile = speakerProfiles.get(patch.profileId)

        if (!profile || profile.workspaceId !== workspaceId) {
          throw new Error(`Speaker profile not found: ${patch.profileId}`)
        }
      }

      const next: StoredSpeaker = { ...row }

      if (patch.displayName !== undefined) next.displayName = patch.displayName ?? undefined
      if (patch.participantId !== undefined) next.participantId = patch.participantId ?? undefined
      if (patch.profileId !== undefined) next.profileId = patch.profileId ?? undefined
      if (patch.suggestion !== undefined) next.suggestion = patch.suggestion ?? undefined
      if (patch.confirmedByUserId !== undefined) {
        next.confirmedByUserId = patch.confirmedByUserId ?? undefined
      }
      if (patch.mappingStatus !== undefined) {
        next.mappingStatus = patch.mappingStatus
        next.confirmedAt =
          patch.mappingStatus === "confirmed" ? new Date().toISOString() : undefined
      }

      speakers.set(speakerId, next)
      bumpTranscriptVersion(meetingId)
      return resolveSpeaker(next)
    },

    async mergeMeetingSpeakers(meetingId, sourceId, targetId) {
      const meeting = requireVisibleMeeting(meetingId)

      if (sourceId === targetId) throw new Error("Cannot merge a speaker into itself")

      const source = requireMeetingSpeaker(meetingId, sourceId)
      const target = requireMeetingSpeaker(meetingId, targetId)
      // Only speaker ids and turn indexes change: text and words are untouched.
      const repointed = (meeting.transcript ?? []).map((segment) =>
        segment.speakerId === sourceId
          ? { ...segment, speakerId: targetId, speaker: target.label }
          : segment
      )
      const turns = computeTurnIndexes(
        repointed,
        (segment) => segment.speakerId ?? segment.speaker
      )
      const merged: StoredSpeaker = {
        ...target,
        talkTimeMs: target.talkTimeMs + source.talkTimeMs,
        wordCount: target.wordCount + source.wordCount,
        segmentCount: target.segmentCount + source.segmentCount,
        firstStartMs:
          target.firstStartMs === undefined
            ? source.firstStartMs
            : source.firstStartMs === undefined
              ? target.firstStartMs
              : Math.min(target.firstStartMs, source.firstStartMs),
      }

      meetings.set(meetingId, {
        ...meeting,
        transcript: repointed.map((segment, index) => ({ ...segment, turnIndex: turns[index] })),
      })
      speakers.delete(sourceId)
      speakers.set(targetId, merged)
      bumpTranscriptVersion(meetingId)
      return resolveSpeaker(merged)
    },

    async setSpeakerSuggestions(meetingId, items) {
      requireVisibleMeeting(meetingId)

      for (const item of items) {
        const row = speakers.get(item.speakerId)

        // Confirmed / rejected mappings are never overwritten automatically.
        if (
          !row ||
          row.meetingId !== meetingId ||
          row.mappingStatus === "confirmed" ||
          row.mappingStatus === "rejected"
        ) {
          continue
        }
        if (item.participantId) {
          const participant = participants.get(item.participantId)

          if (!participant || participant.meetingId !== meetingId) continue
        }

        const next: StoredSpeaker = {
          ...row,
          suggestion: item.suggestion ?? undefined,
          mappingStatus: item.mappingStatus ?? row.mappingStatus,
        }

        if (item.participantId !== undefined) {
          next.participantId = item.participantId ?? undefined
        }
        if (next.mappingStatus === "confirmed") next.confirmedAt = new Date().toISOString()
        speakers.set(row.id, next)
      }

      bumpTranscriptVersion(meetingId)
      return meetingSpeakerRows(meetingId).map((row) => resolveSpeaker(row))
    },

    async listSpeakerProfiles() {
      return [...speakerProfiles.values()]
        .filter((profile) => profile.workspaceId === workspaceId)
        .sort(
          (a, b) =>
            b.confirmedCount - a.confirmedCount || a.displayName.localeCompare(b.displayName)
        )
        .map(publicProfile)
    },

    async recordConfirmedSpeaker(input) {
      requireVisibleMeeting(input.meetingId)

      const speaker = requireMeetingSpeaker(input.meetingId, input.speakerId)
      const name = input.participant.name.normalize("NFC").trim().replace(/\s+/gu, " ")
      const email = input.participant.email?.trim().toLowerCase() || undefined
      const existing = [...speakerProfiles.values()].find(
        (profile) =>
          profile.workspaceId === workspaceId &&
          (email
            ? profile.email?.toLowerCase() === email
            : !profile.email &&
              normalizeProfileName(profile.displayName) === normalizeProfileName(name))
      )
      const embedding = input.embedding ?? speaker.embedding
      const embeddingModel = input.embedding ? input.embeddingModel : speaker.embeddingModel
      const now = new Date().toISOString()
      const profile: StoredSpeakerProfile = existing
        ? {
            ...existing,
            displayName: name,
            aliases: unionAliases(existing.aliases, input.aliases),
            confirmedCount: existing.confirmedCount + 1,
            lastMeetingId: input.meetingId,
            lastConfirmedAt: now,
          }
        : {
            id: createId("speaker_profile"),
            workspaceId,
            displayName: name,
            email,
            aliases: unionAliases(input.aliases),
            confirmedCount: 1,
            embeddingSamples: 0,
            lastMeetingId: input.meetingId,
            lastConfirmedAt: now,
          }

      if (embedding?.length) {
        const previous = profile.voiceEmbedding
        const sameModel =
          previous !== undefined &&
          (profile.embeddingModel ?? null) === (embeddingModel ?? null)

        profile.voiceEmbedding = sameModel
          ? runningMeanEmbedding(previous, profile.embeddingSamples, embedding)
          : [...embedding]
        profile.embeddingModel = embeddingModel
        profile.embeddingSamples = sameModel ? profile.embeddingSamples + 1 : 1
      }

      speakerProfiles.set(profile.id, profile)
      speakers.set(speaker.id, { ...speaker, profileId: profile.id })
      bumpTranscriptVersion(input.meetingId)
      return publicProfile(profile)
    },

    async getMeetingTranscript(meetingId) {
      const meeting = visibleMeeting(meetingId)

      if (!meeting) return undefined

      const hydrated = hydrate(meeting)

      return {
        meetingId,
        version: meeting.transcriptVersion ?? 0,
        segments: hydrated.transcript ?? [],
        speakers: hydrated.speakers ?? [],
        language: meeting.language,
      }
    },

    async getTranscriptVersion(meetingId) {
      const meeting = visibleMeeting(meetingId)

      return meeting ? (meeting.transcriptVersion ?? 0) : undefined
    },

    async updateTranscriptSegment(meetingId, segmentId, patch) {
      const { meeting, transcript, current } = requireEditableSegment(
        meetingId,
        segmentId,
        patch.expectedRevision
      )

      if (patch.speakerId !== undefined) {
        const target = speakers.get(patch.speakerId)

        if (!target || target.meetingId !== meetingId) {
          throw new TranscriptSpeakerNotFoundError(patch.speakerId)
        }
      }

      const textChanged = patch.text !== undefined && patch.text !== current.text
      const speakerChanged =
        patch.newSpeakerName !== undefined ||
        (patch.speakerId !== undefined && patch.speakerId !== current.speakerId)

      if (!textChanged && !speakerChanged) {
        return { segment: resolveSegment(current), version: meeting.transcriptVersion ?? 0 }
      }

      let targetSpeaker: StoredSpeaker | undefined

      if (patch.newSpeakerName !== undefined) {
        targetSpeaker = {
          id: createId("speaker"),
          meetingId,
          workspaceId: meetingWorkspaceId(meeting),
          label: nextSpeakerLabel(meetingSpeakerRows(meetingId).map((row) => row.label)),
          displayName: patch.newSpeakerName,
          mappingStatus: "confirmed",
          confirmedAt: new Date().toISOString(),
          confirmedByUserId: patch.actorUserId,
          source: "manual",
          talkTimeMs: 0,
          wordCount: 0,
          segmentCount: 0,
        }
        speakers.set(targetSpeaker.id, targetSpeaker)
      } else if (speakerChanged) {
        targetSpeaker = speakers.get(patch.speakerId as string)
      }

      const changedIds = new Set([segmentId])

      if (targetSpeaker && patch.scope === "turn" && current.turnIndex !== undefined) {
        for (const segment of transcript) {
          if (segment.turnIndex === current.turnIndex && segment.speakerId === current.speakerId) {
            changedIds.add(segment.id)
          }
        }
      }

      const now = new Date().toISOString()
      let next = transcript.map((segment) => {
        if (!changedIds.has(segment.id)) return segment

        storeRevision(meetingId, segment, patch.actorUserId)

        const updated: TranscriptSegment = {
          ...segment,
          source: "edited",
          revision: (segment.revision ?? 0) + 1,
          editedAt: now,
        }

        if (targetSpeaker) {
          updated.speakerId = targetSpeaker.id
          updated.speaker = targetSpeaker.label
        }
        if (segment.id === segmentId && textChanged) {
          updated.text = patch.text as string
          updated.words =
            patch.words ??
            realignWords(segment.words, patch.text as string, {
              startMs: segment.startMs,
              endMs: segment.endMs,
            })
        }
        return updated
      })

      if (speakerChanged) {
        next = withTurnIndexes(next)
        recomputeSpeakerStats(meetingId, next)
      }

      meetings.set(meetingId, { ...meeting, transcript: next })
      pruneRevisions(meetingId, [...changedIds])

      return mutationResult(
        meetingId,
        next,
        segmentId,
        speakerChanged,
        bumpTranscriptVersion(meetingId)
      )
    },

    async undoTranscriptSegment(meetingId, segmentId, options) {
      const { meeting, transcript, current } = requireEditableSegment(
        meetingId,
        segmentId,
        options.expectedRevision
      )
      const revision = segmentRevisions(meetingId, segmentId).find((item) => !item.revertedAt)

      if (!revision) throw new NothingToUndoError(segmentId)

      const candidate = revision.speakerId ? speakers.get(revision.speakerId) : undefined
      // A speaker merged away since keeps the segment on its current speaker.
      const restoredSpeaker = candidate?.meetingId === meetingId ? candidate : undefined
      const speakerChanged = Boolean(restoredSpeaker) && restoredSpeaker?.id !== current.speakerId
      const now = new Date().toISOString()
      let next = transcript.map((segment) => {
        if (segment.id !== segmentId) return segment

        const restored: TranscriptSegment = {
          ...segment,
          text: revision.text,
          source: revision.source,
          revision: (segment.revision ?? 0) + 1,
          editedAt: now,
        }

        if (revision.words) restored.words = revision.words.map((word) => ({ ...word }))
        else delete restored.words
        if (restoredSpeaker) {
          restored.speakerId = restoredSpeaker.id
          restored.speaker = restoredSpeaker.label
        }
        return restored
      })

      if (speakerChanged) {
        next = withTurnIndexes(next)
        recomputeSpeakerStats(meetingId, next)
      }

      meetings.set(meetingId, { ...meeting, transcript: next })
      transcriptRevisions.set(revision.id, { ...revision, revertedAt: now })

      return mutationResult(
        meetingId,
        next,
        segmentId,
        speakerChanged,
        bumpTranscriptVersion(meetingId)
      )
    },

    async listTranscriptRevisions(meetingId, segmentId) {
      requireVisibleMeeting(meetingId)

      return segmentRevisions(meetingId, segmentId).map((revision) => {
        const { workspaceId: revisionWorkspace, ...rest } = revision

        void revisionWorkspace
        return rest
      })
    },

    async renameMeeting(id, title) {
      const meeting = requireVisibleMeeting(id)
      const updated: MeetingRecord = { ...meeting, title, titleSource: "user" }

      meetings.set(id, updated)
      return hydrate(updated, false)
    },

    async deleteMeeting(id) {
      const meeting = visibleMeeting(id)

      if (!meeting) return undefined

      const assets = meeting.mediaAssets ?? []
      const storageKeys = [
        ...new Set(
          assets.flatMap((asset) =>
            [asset.storageKey, asset.peaksStorageKey].filter((key): key is string => Boolean(key))
          )
        ),
      ]

      removeMeetingRows(id)
      return { storageKeys, title: meeting.title, assetCount: assets.length }
    },

    async updateMediaAssetPreparation(assetId, patch) {
      for (const meeting of visibleMeetings()) {
        const asset = meeting.mediaAssets?.find((candidate) => candidate.id === assetId)

        if (!asset) continue

        const updated: MediaAsset = { ...asset }

        if (patch.durationMs !== undefined) updated.durationMs = patch.durationMs ?? undefined
        if (patch.peaksStorageKey !== undefined) {
          updated.peaksStorageKey = patch.peaksStorageKey ?? undefined
        }
        if (patch.preparedAt !== undefined) updated.preparedAt = patch.preparedAt ?? undefined
        if (patch.prepareError !== undefined) {
          updated.prepareError = patch.prepareError ?? undefined
        }

        meetings.set(meeting.id, {
          ...meeting,
          mediaAssets: meeting.mediaAssets?.map((item) => (item.id === assetId ? updated : item)),
        })
        return updated
      }

      throw new Error(`Media asset not found: ${assetId}`)
    },

    async setMeetingDurationMs(meetingId, durationMs, source) {
      const meeting = requireVisibleMeeting(meetingId)

      // A transcript end never overrides a probed media duration.
      if (source === "transcript" && (meeting.mediaAssets ?? []).some((asset) => asset.durationMs)) {
        return
      }

      meetings.set(meetingId, { ...meeting, durationMs: Math.round(durationMs) })
    },

    async upsertMeetingIntelligence(
      meetingId: string,
      intelligence: MeetingIntelligence
    ): Promise<MeetingIntelligence> {
      const meeting = requireVisibleMeeting(meetingId)
      const meetingWorkspace = meetingWorkspaceId(meeting)
      const existing = meeting.summary?.actionItems ?? []
      const plan = mergeActionItems(existing, intelligence.actionItems, () =>
        createId("act")
      )
      const stamp = (item: ActionItem): ActionItem => ({
        ...item,
        meetingId,
        workspaceId: meetingWorkspace,
        createdAt: item.createdAt ?? new Date().toISOString(),
      })
      const updates = new Map(plan.update.map((item) => [item.id, item]))
      const kept = new Set(plan.keep.map((item) => item.id))
      const actionItems = [
        ...existing.flatMap((item) =>
          kept.has(item.id)
            ? [item]
            : updates.has(item.id)
              ? [stamp({ ...updates.get(item.id)!, createdAt: item.createdAt })]
              : []
        ),
        ...plan.insert.map(stamp),
      ]
      const persisted: MeetingIntelligence = {
        ...intelligence,
        actionItems: actionItems as MeetingIntelligence["actionItems"],
      }
      const updatedMeeting: MeetingRecord = {
        ...meeting,
        status: "completed",
        intelligence: persisted,
        languageMetadata: intelligence.languageMetadata,
        tags: intelligence.tags,
        summary: {
          overview: intelligence.overview,
          decisions: intelligence.decisions,
          actionItems,
        },
      }

      meetings.set(meetingId, updatedMeeting)
      return persisted
    },

    async updateActionItem(id, patch): Promise<ActionItem> {
      for (const meeting of visibleMeetings()) {
        const actionItems = meeting.summary?.actionItems ?? []
        const index = actionItems.findIndex((item) => item.id === id)

        if (index < 0) continue

        const current = actionItems[index]
        const updatedItem: ActionItem = {
          ...current,
          meetingId: meeting.id,
          workspaceId: meetingWorkspaceId(meeting),
        }

        if (patch.title !== undefined) updatedItem.title = patch.title
        if (patch.priority !== undefined) updatedItem.priority = patch.priority
        if (patch.status !== undefined) {
          updatedItem.status = patch.status
          updatedItem.completedAt =
            patch.status === "done"
              ? (current.completedAt ?? new Date().toISOString())
              : undefined
        }

        if (hasOwnerPatch(patch)) {
          const participant = patch.ownerParticipantId
            ? ensureParticipants(meeting).find(
                (candidate) => candidate.id === patch.ownerParticipantId
              )
            : undefined
          const ownerText = ownerTextOf(patch)
          const speaker = participant
            ? meetingSpeakerRows(meeting.id).find(
                (row) => row.participantId === participant.id
              )
            : undefined

          updatedItem.ownerText = ownerText ?? undefined
          updatedItem.ownerParticipantId = participant?.id
          updatedItem.ownerSpeakerId = speaker?.id
          updatedItem.ownerUserId = patch.ownerUserId ?? undefined
          updatedItem.owner = ownerText ?? participant?.name
        }

        const due = resolveDuePatch(patch, meeting.startedAt, getTaskTimeZone())

        if (due) {
          updatedItem.dueOn = due.dueOn ?? undefined
          updatedItem.dueText = due.dueText ?? undefined
          updatedItem.dueSource = due.dueSource ?? undefined
          updatedItem.dueDate = due.dueDate ?? undefined
          updatedItem.dueConfidence = undefined
        }

        updatedItem.editedByUser = current.editedByUser === true || isContentPatch(patch)

        const updatedActionItems = [...actionItems]

        updatedActionItems[index] = updatedItem
        writeActionItems(meeting, updatedActionItems)
        return updatedItem
      }

      throw new Error(`Action item not found: ${id}`)
    },

    async createActionItem(meetingId, input, actor): Promise<ActionItem> {
      const meeting = requireVisibleMeeting(meetingId)
      const title = input.title.trim()

      if (!title) throw new Error("Action item title is required")

      const participant = input.ownerParticipantId
        ? ensureParticipants(meeting).find(
            (candidate) => candidate.id === input.ownerParticipantId
          )
        : undefined
      const speaker = participant
        ? meetingSpeakerRows(meeting.id).find((row) => row.participantId === participant.id)
        : undefined
      const dueText = input.dueText?.trim() || undefined
      const dueOn =
        input.dueOn && isDateOnly(input.dueOn)
          ? input.dueOn
          : dueText
            ? parseDueDate(dueText, { anchor: meeting.startedAt, timeZone: getTaskTimeZone() })?.date
            : undefined
      const ownerText = input.ownerText?.trim() || undefined
      const item: ActionItem = {
        id: createId("act"),
        title,
        status: "open",
        priority: input.priority ?? "normal",
        kind: "explicit",
        origin: "user",
        editedByUser: true,
        originalTitle: title,
        owner: ownerText ?? participant?.name,
        ownerText,
        ownerParticipantId: participant?.id,
        ownerSpeakerId: speaker?.id,
        ownerUserId: input.ownerUserId,
        dueOn,
        dueText,
        dueSource: dueOn || dueText ? "user" : undefined,
        dueDate: dueOn ? dueDateFromDueOn(dueOn) : undefined,
        sourceSegmentId: input.sourceSegmentId,
        sourceStartMs: input.sourceStartMs,
        meetingId,
        workspaceId: meetingWorkspaceId(meeting),
        createdByUserId: actor.userId,
        createdAt: new Date().toISOString(),
      }

      writeActionItems(meeting, [...(meeting.summary?.actionItems ?? []), item])
      return item
    },

    async deleteActionItem(id) {
      for (const meeting of visibleMeetings()) {
        const actionItems = meeting.summary?.actionItems ?? []

        if (!actionItems.some((item) => item.id === id)) continue

        writeActionItems(
          meeting,
          actionItems.filter((item) => item.id !== id)
        )
        return true
      }

      return false
    },

    async setMeetingTemplate(id, templateKey) {
      const meeting = requireVisibleMeeting(id)
      const updated: MeetingRecord = { ...meeting, templateKey: templateKey ?? undefined }

      meetings.set(id, updated)
      return hydrate(updated, false)
    },

    async applyAiTitle(id, title) {
      const meeting = visibleMeeting(id)

      if (!meeting || meeting.titleSource === "user") return false

      meetings.set(id, { ...meeting, title, titleSource: "ai" })
      return true
    },

    async setMeetingTitle(id, title, source) {
      const meeting = requireVisibleMeeting(id)
      const updated: MeetingRecord = { ...meeting, title, titleSource: source }

      meetings.set(id, updated)
      return hydrate(updated, false)
    },

    async createJob(input): Promise<JobRecord> {
      const id = input.id ?? createId("job")
      const owner = jobWorkspaces.get(id)

      if (owner && owner !== workspaceId) {
        throw new Error(`Job id already in use: ${id}`)
      }

      const now = new Date().toISOString()
      const job: JobRecord = {
        id,
        name: input.name,
        status: input.status ?? "queued",
        // Linked only when visible (mirrors the Postgres repository).
        meetingId:
          input.meetingId && visibleMeeting(input.meetingId)
            ? input.meetingId
            : undefined,
        payload: input.payload ?? {},
        result: {},
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        retryOfJobId: input.retryOfJobId,
        retryable: false,
        createdAt: now,
        updatedAt: now,
      }

      jobs.set(job.id, job)
      jobWorkspaces.set(job.id, workspaceId)
      return job
    },

    async updateJob(id, patch): Promise<JobRecord> {
      const job = scopedJob(id)

      if (!job) {
        throw new Error(`Job not found: ${id}`)
      }

      const updated = {
        ...job,
        ...patch,
        startedAt:
          patch.startedAt ??
          (patch.status === "active" ? new Date().toISOString() : job.startedAt),
        completedAt:
          patch.completedAt ??
          (patch.status === "completed" || patch.status === "failed"
            ? new Date().toISOString()
            : job.completedAt),
        retryable:
          patch.status === "failed"
            ? (patch.attempts ?? job.attempts) < job.maxAttempts
            : job.retryable,
        updatedAt: new Date().toISOString(),
      }

      jobs.set(id, updated)
      return updated
    },

    async getJob(id): Promise<JobRecord | undefined> {
      return scopedJob(id)
    },

    async listJobs(filters = {}): Promise<JobRecord[]> {
      return [...jobs.values()]
        .filter(isScopedJob)
        .filter((job) =>
          filters.meetingId ? job.meetingId === filters.meetingId : true
        )
        .filter((job) => (filters.status ? job.status === filters.status : true))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },

    async searchMeetings(
      query: string,
      options?: { limit?: number }
    ): Promise<MeetingRecord[]> {
      return listFullMeetingsPage({
        query: normalize(query),
        limit: options?.limit,
        sort: "recent",
      }).meetings
    },

    async askMeetingMemory(
      meetingId: string,
      question: string
    ): Promise<MeetingAnswer> {
      const meeting = requireVisibleMeeting(meetingId)
      const normalizedQuestion = normalize(question)
      const transcriptMatch = meeting.transcript?.find((segment) =>
        normalize(segment.text).includes(
          normalizedQuestion.includes("realizeos") ? "realizeos" : ""
        )
      )

      const answer =
        meeting.summary?.overview ??
        transcriptMatch?.text ??
        "No summary is available for this meeting yet."

      return {
        answer,
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

    async getMeetingIntelligence(
      meetingId: string
    ): Promise<MeetingIntelligence | undefined> {
      return visibleMeeting(meetingId)?.intelligence
    },

    async runMeetingIntelligence(
      meetingId: string
    ): Promise<MeetingIntelligence> {
      const meeting = requireVisibleMeeting(meetingId)
      const intelligence = buildMeetingIntelligence(meeting)

      return this.upsertMeetingIntelligence(meetingId, intelligence)
    },

    async listContexts(): Promise<MeetingContext[]> {
      return [...contexts.values()]
        .filter((context) => contextWorkspaces.get(context.id) === workspaceId)
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    async createContext(input: CreateContextInput): Promise<MeetingContext> {
      const context: MeetingContext = {
        id: createId("ctx"),
        name: input.name,
        description: input.description,
        createdAt: new Date().toISOString(),
      }

      contexts.set(context.id, context)
      contextWorkspaces.set(context.id, workspaceId)
      return context
    },

    async linkMeetingContext(
      meetingId: string,
      contextId: string
    ): Promise<MeetingRecord> {
      const meeting = requireVisibleMeeting(meetingId)
      const context = scopedContext(contextId)

      if (!context) {
        throw new Error(`Context not found: ${contextId}`)
      }

      const nextContexts = [
        ...(meeting.contexts ?? []).filter((item) => item.id !== context.id),
        context,
      ]
      const updatedMeeting = { ...meeting, contexts: nextContexts }

      meetings.set(meetingId, updatedMeeting)
      return hydrate(updatedMeeting)
    },

    async listRooms(): Promise<Array<MeetingContext & { meetingCount: number }>> {
      const visible = visibleMeetings()

      return (await this.listContexts()).map((context) => ({
        ...context,
        meetingCount: visible.filter((meeting) =>
          meeting.contexts?.some((item) => item.id === context.id)
        ).length,
      }))
    },

    async listMeetingsByContext(contextId: string): Promise<MeetingRecord[]> {
      return visibleMeetings()
        .filter((meeting) =>
          meeting.contexts?.some((context) => context.id === contextId)
        )
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        )
        .map((meeting) => hydrate(meeting))
    },

    async updateMeetingTags(meetingId, tags): Promise<MeetingRecord> {
      const meeting = requireVisibleMeeting(meetingId)
      const normalizedTags = [...new Set(tags.map((tag) => tag.trim()))].filter(
        Boolean
      ) as MeetingTag[]
      const updatedMeeting = { ...meeting, tags: normalizedTags }

      meetings.set(meetingId, updatedMeeting)
      return hydrate(updatedMeeting)
    },

    async updateMeetingFavorite(meetingId, favorite): Promise<MeetingRecord> {
      if (!favoriteUserId) {
        throw new MeetingScopeError(
          "Favorites are per user and need a signed-in member",
          400
        )
      }

      const meeting = requireVisibleMeeting(meetingId)
      const key = favoriteKey(favoriteUserId, meetingId)

      if (favorite) favorites.add(key)
      else favorites.delete(key)

      return hydrate(meeting)
    },

    async createMeetingShare(input): Promise<MeetingShare> {
      const meeting = requireVisibleMeeting(input.meetingId)

      // A share link only works while the meeting is `link`-visible.
      setLinkVisibility(meeting)

      const existing = latestShare(input.meetingId, true)

      if (existing) return existing

      const now = new Date().toISOString()
      const passwordHash = input.password
        ? (await import("@/lib/auth/api-keys")).createApiKeyHash(input.password)
        : undefined
      const share: MeetingShare = {
        id: createId("share"),
        meetingId: input.meetingId,
        token: crypto.randomUUID().replaceAll("-", ""),
        visibility: "public",
        revoked: false,
        expiresAt: input.expiresAt,
        passwordHash,
        includedSections: input.includedSections ?? [...DEFAULT_SHARE_SECTIONS],
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      }

      shares.set(share.id, share)
      return share
    },

    async updateMeetingVisibility(meetingId, visibility): Promise<MeetingRecord> {
      const meeting = requireVisibleMeeting(meetingId)
      const updated: MeetingRecord = { ...meeting, visibility }

      meetings.set(meetingId, updated)

      // Leaving `link` revokes the meeting-scope shares; going `private`
      // also revokes clip shares (M5).
      if (visibility !== "link") {
        const now = new Date().toISOString()

        for (const share of shares.values()) {
          if (
            share.meetingId === meetingId &&
            !share.revoked &&
            (isMeetingScopeShare(share) || visibility === "private")
          ) {
            shares.set(share.id, { ...share, revoked: true, updatedAt: now })
          }
        }
      }

      return hydrate(updated)
    },

    async updateMeetingShare(meetingId, patch): Promise<MeetingShare> {
      const meeting = requireVisibleMeeting(meetingId)
      const existing = latestShare(meetingId, false)

      if (patch.regenerate) {
        if (existing) {
          shares.set(existing.id, {
            ...existing,
            revoked: true,
            updatedAt: new Date().toISOString(),
          })
        }

        return this.createMeetingShare({
          meetingId,
          includedSections: patch.includedSections,
        })
      }

      if (!existing) {
        return this.createMeetingShare({
          meetingId,
          includedSections: patch.includedSections,
        })
      }

      if (patch.revoked === false) setLinkVisibility(meeting)

      const updated: MeetingShare = {
        ...existing,
        revoked: patch.revoked ?? existing.revoked,
        includedSections: patch.includedSections ?? existing.includedSections,
        updatedAt: new Date().toISOString(),
      }

      shares.set(existing.id, updated)
      return updated
    },

    async getShareByToken(token) {
      const share = [...shares.values()].find(
        (item) => item.token === token && !item.revoked && isMeetingScopeShare(item)
      )
      const expired =
        share?.expiresAt && new Date(share.expiresAt).getTime() < Date.now()

      if (!share || expired) return undefined

      const meeting = visibleMeeting(share.meetingId)

      if (!meeting || meeting.visibility !== "link") return undefined
      return { share, meeting: hydrate(meeting) }
    },

    async listMeetingParticipants(meetingId) {
      return ensureParticipants(requireVisibleMeeting(meetingId))
    },

    async updateMeetingParticipant(participantId, patch) {
      const participant = participants.get(participantId)

      if (!participant || !visibleMeeting(participant.meetingId)) {
        throw new Error(`Participant not found: ${participantId}`)
      }

      const updated: MeetingParticipant = {
        ...participant,
        ...patch,
        updatedAt: new Date().toISOString(),
      }

      participants.set(participantId, updated)
      // Speaker names resolve through participants.
      bumpTranscriptVersion(participant.meetingId)
      return updated
    },

    async assignSpeakerToParticipant(meetingId, speakerLabel, participantId) {
      const participant = participants.get(participantId)
      const meeting = visibleMeeting(meetingId)

      if (!participant || participant.meetingId !== meetingId || !meeting) {
        throw new Error(`Participant not found: ${participantId}`)
      }

      const updatedParticipant = await this.updateMeetingParticipant(participantId, {
        speakerLabel,
      })
      const speaker = meetingSpeakerRows(meetingId).find(
        (row) =>
          row.label === speakerLabel || resolveSpeaker(row).displayName === speakerLabel
      )

      // The name reaches segments through the speaker → participant link;
      // segment text and words are never rewritten.
      if (speaker) {
        await this.updateMeetingSpeaker(meetingId, speaker.id, {
          participantId,
          mappingStatus: "confirmed",
        })
      }

      return updatedParticipant
    },

    async createExportRecord(input): Promise<ExportRecord> {
      requireVisibleMeeting(input.meetingId)

      const record: ExportRecord = {
        id: createId("export"),
        meetingId: input.meetingId,
        format: input.format,
        status: "created",
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
      }

      exportRecords.set(record.id, record)
      return record
    },

    async approveAgentRun(id): Promise<SuggestedAgentRun> {
      const run = suggestedRuns.get(id)

      if (!run || !visibleMeeting(run.meetingId)) {
        throw new Error(`Agent run not found: ${id}`)
      }

      const updated = { ...run, status: "queued" as const }

      suggestedRuns.set(id, updated)
      return updated
    },

    async createSuggestedAgentRun(input): Promise<SuggestedAgentRun> {
      const meeting = requireVisibleMeeting(input.meetingId)
      const suggestion: SuggestedAgentRun = {
        id: createId("agent_suggestion"),
        meetingId: input.meetingId,
        target: input.target,
        payload: input.payload,
        response: {},
        status: "suggested",
        createdAt: new Date().toISOString(),
      }
      const updatedMeeting = {
        ...meeting,
        suggestedAgentRuns: [
          ...(meeting.suggestedAgentRuns ?? []),
          suggestion,
        ],
      }

      meetings.set(input.meetingId, updatedMeeting)
      suggestedRuns.set(suggestion.id, suggestion)
      return suggestion
    },
  }
}

/**
 * Lightweight result of a share-token lookup for the public media routes
 * (M4): the share, the meeting's identity/visibility and its media asset
 * rows only — no transcript, summary, speakers or participants are loaded
 * (every Range request of a shared recording hits this).
 */
export type ShareMediaLookupResult = {
  share: MeetingShare
  meeting: Pick<MeetingRecord, "id" | "workspaceId" | "visibility">
  mediaAssets: MediaAsset[]
}

export type GetShareMediaByToken = (token: string) => Promise<ShareMediaLookupResult | undefined>

/**
 * Cross-workspace share-token lookup over an in-memory database (mirrors
 * createPostgresShareLookup): active, unexpired share AND `link` visibility.
 */
export function createInMemoryShareLookup(db: InMemoryMeetingDatabase): {
  getShareByToken: MeetingRepository["getShareByToken"]
  getShareMediaByToken: GetShareMediaByToken
} {
  return {
    async getShareMediaByToken(token) {
      const share = [...db.shares.values()].find(
        (item) => item.token === token && !item.revoked && isMeetingScopeShare(item)
      )
      const expired =
        share?.expiresAt && new Date(share.expiresAt).getTime() < Date.now()
      const meeting = share && !expired ? db.meetings.get(share.meetingId) : undefined

      if (!share || !meeting || meeting.visibility !== "link") return undefined

      return {
        share,
        meeting: {
          id: meeting.id,
          workspaceId: meetingWorkspaceId(meeting),
          visibility: meeting.visibility,
        },
        mediaAssets: [...(meeting.mediaAssets ?? [])],
      }
    },

    async getShareByToken(token) {
      const share = [...db.shares.values()].find(
        (item) => item.token === token && !item.revoked && isMeetingScopeShare(item)
      )
      const meeting = share ? db.meetings.get(share.meetingId) : undefined

      if (!share || !meeting) return undefined

      return createInMemoryMeetingRepository(db, {
        kind: "system",
        workspaceId: meetingWorkspaceId(meeting),
      }).getShareByToken(token)
    },
  }
}
