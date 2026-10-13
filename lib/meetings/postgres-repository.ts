import { createHash } from "node:crypto"
import type { Queryable } from "@/lib/db/client"
import type {
  ActionItem,
  CreateContextInput,
  CreateMeetingInput,
  ExportRecord,
  JobRecord,
  JobStatus,
  MediaAsset,
  MeetArtifact,
  MeetConferenceRecord,
  AiRunRecord,
  MeetingAnswer,
  MeetingContext,
  MeetingListOptions,
  MeetingListSortMode,
  MeetingParticipant,
  MeetingRecord,
  MeetingRepository,
  MeetingShare,
  MeetingVisibility,
  RepoScope,
  SuggestedAgentRun,
} from "@/lib/meetings/repository"
import {
  MeetingExternalIdConflictError,
  MeetingScopeError,
  notImplementedM3,
} from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/visibility"
import { mergeActionItems } from "@/lib/meetings/action-item-merge"
import { deriveMeetingQualityWarnings } from "@/lib/meetings/quality"
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
}

type TranscriptRow = {
  id: string
  speaker_label: string | null
  start_ms: number
  end_ms: number
  text: string
  confidence: string | number | null
  language: string | null
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
  metadata: Record<string, unknown> | null
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
  }
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
    createdAt: toIso(row.created_at),
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

const ACTION_ITEM_COLUMNS = `
  id, title, owner, status, due_date, priority, confidence,
  source_quote, source_start_ms, kind, edited_by_user, origin,
  original_title, completed_at
`

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
  ]
    .map((column) => `${alias}.${column}`)
    .join(", ")
}

const SHARE_COLUMNS = `
  id, meeting_id, token, visibility, revoked, expires_at,
  included_sections, created_by, created_at, updated_at
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
  checksum_sha256, metadata, created_at
`

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

  async function hydrateMeeting(base: MeetingRecord): Promise<MeetingRecord> {
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
    ] = await Promise.all([
      client.query(
        `
          select
            ts.id,
            coalesce(s.display_name, s.label) as speaker_label,
            ts.start_ms,
            ts.end_ms,
            ts.text,
            ts.confidence,
            ts.language
          from transcript_segments ts
          left join speakers s on s.id = ts.speaker_id
          where ts.meeting_id = $1
          order by ts.start_ms asc
        `,
        [base.id]
      ),
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
    ])

    const transcript = (transcriptResult.rows as TranscriptRow[]).map(
      (segment) => ({
        id: segment.id,
        speaker: segment.speaker_label ?? "Speaker",
        startMs: segment.start_ms,
        endMs: segment.end_ms,
        text: segment.text,
        confidence:
          segment.confidence === null ? undefined : Number(segment.confidence),
        language: segment.language ?? undefined,
      })
    )

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
      isFavorite: favoriteResult.rows.length > 0,
      transcript,
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
      mediaAssets: (mediaAssetsResult.rows as MediaAssetRow[]).map(mapMediaAsset),
      meetConferenceRecords: mapMeetConferenceRecords(
        meetArtifactsResult.rows as MeetArtifactRow[]
      ),
      aiRuns: (aiRunsResult.rows as AiRunRow[]).map(mapAiRun),
      participantDetails:
        participantDetails.length > 0
          ? participantDetails
          : base.participants.map((participant, index) => ({
              id: `derived_${base.id}_${index}`,
              meetingId: base.id,
              name: participant.includes("@")
                ? participant.split("@")[0]
                : participant,
              email: participant.includes("@") ? participant : undefined,
              role: index === 0 ? "organizer" : "attendee",
              source: "calendar",
              attendanceStatus: "unknown",
              confidence: 0.4,
              createdAt: base.startedAt,
              updatedAt: base.startedAt,
            })),
    }

    return {
      ...hydrated,
      qualityWarnings: deriveMeetingQualityWarnings(hydrated),
    }
  }

  async function getScopedMeeting(id: string) {
    const row = await selectMeeting(client, "m.id = $1", [id])

    return row ? hydrateMeeting(mapMeetingRow(row)) : undefined
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
    return mapParticipant(row)
  }

  async function latestShare(meetingId: string, activeOnly: boolean) {
    const result = await client.query(
      `
        select ${SHARE_COLUMNS}
        from meeting_shares
        where meeting_id = $1
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
      return (await this.listMeetingsPage(options)).meetings
    },

    async listMeetingsPage(options: MeetingListOptions = {}) {
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
      const meetings = await Promise.all(
        bases.map((meeting) => hydrateMeeting(meeting))
      )

      return {
        meetings,
        page: {
          limit,
          offset,
          total,
          hasMore: offset + meetings.length < total,
        },
      }
    },

    async getMeeting(id: string) {
      return getScopedMeeting(id)
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
      ]
      const result = await client.query(
        `
          insert into media_assets (
            id, meeting_id, storage_key, filename, content_type, size_bytes,
            retention, source, source_file_id, checksum_sha256, metadata,
            workspace_id
          )
          select $1, m.id, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, m.workspace_id
          from meetings m
          where m.id = $2 and ${scoped("m", values)}
          returning ${MEDIA_ASSET_COLUMNS}
        `,
        values
      )
      const row = result.rows[0] as MediaAssetRow | undefined

      if (!row) throw new Error(`Meeting not found: ${input.meetingId}`)

      await updateScopedMeeting(client, input.meetingId, "status = 'media_uploaded'", [])

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
      await withTransaction(client, async (tx) => {
        await assertMeetingInScope(tx, meetingId)
        await tx.query(`delete from transcript_segments where meeting_id = $1`, [
          meetingId,
        ])
        await tx.query(`delete from speakers where meeting_id = $1`, [meetingId])

        const speakerIds = new Map<string, string>()

        for (const segment of segments) {
          let speakerId = speakerIds.get(segment.speaker)

          if (!speakerId) {
            speakerId = createId("speaker")
            speakerIds.set(segment.speaker, speakerId)
            await tx.query(
              `
                insert into speakers (id, meeting_id, label, display_name)
                values ($1, $2, $3, $3)
              `,
              [speakerId, meetingId, segment.speaker]
            )
          }

          await tx.query(
            `
              insert into transcript_segments (
                id, meeting_id, speaker_id, start_ms, end_ms, text, confidence, language
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
            [
              segment.id || createId("seg"),
              meetingId,
              speakerId,
              segment.startMs,
              segment.endMs,
              segment.text,
              segment.confidence ?? null,
              segment.language ?? null,
            ]
          )
        }

        for (const speakerLabel of speakerIds.keys()) {
          await tx.query(
            `
              insert into meeting_participants (
                id, meeting_id, name, role, source, attendance_status,
                speaker_label, confidence
              )
              values ($1, $2, $3, 'speaker', 'transcript', 'unknown', $3, 0.65)
              on conflict (id) do update set
                speaker_label = excluded.speaker_label,
                updated_at = now()
            `,
            [
              participantRowId(meetingId, speakerLabel),
              meetingId,
              speakerLabel,
            ]
          )
        }
      })

      return segments
    },

    async replaceTranscript() {
      return notImplementedM3("replaceTranscript")
    },

    async listMeetingSpeakers() {
      return notImplementedM3("listMeetingSpeakers")
    },

    async updateMeetingSpeaker() {
      return notImplementedM3("updateMeetingSpeaker")
    },

    async mergeMeetingSpeakers() {
      return notImplementedM3("mergeMeetingSpeakers")
    },

    async setSpeakerSuggestions() {
      return notImplementedM3("setSpeakerSuggestions")
    },

    async listSpeakerProfiles() {
      return notImplementedM3("listSpeakerProfiles")
    },

    async recordConfirmedSpeaker() {
      return notImplementedM3("recordConfirmedSpeaker")
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
            ]
          )
        }

        for (const item of plan.insert) {
          await tx.query(
            `
              insert into action_items (
                id, meeting_id, title, owner, status, due_date, priority,
                confidence, source_quote, source_start_ms, kind,
                origin, original_title, edited_by_user
              )
              values (
                $1, $2, $3, $4, $5, $6, coalesce($7, 'normal'), $8, $9, $10,
                coalesce($11, 'explicit'), 'ai', $3, false
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
              id, meeting_id, overview, language, model_provider, intelligence_run_id
            )
            values ($1, $2, $3, $4, $5, $6)
            returning id
          `,
          [
            createId("summary"),
            meetingId,
            intelligence.overview,
            intelligence.languageMetadata.primaryLanguage,
            provider,
            runId,
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
      const contentEdited =
        patch.title !== undefined ||
        patch.owner !== undefined ||
        patch.dueDate !== undefined ||
        patch.priority !== undefined
      const values: unknown[] = [
        id,
        patch.title ?? null,
        patch.owner ?? null,
        patch.status ?? null,
        coerceDueDate(patch.dueDate),
        patch.priority ?? null,
        contentEdited,
      ]
      const result = await client.query(
        `
          update action_items
          set title = coalesce($2, title),
              owner = coalesce($3, owner),
              status = coalesce($4, status),
              due_date = coalesce($5, due_date),
              priority = coalesce($6, priority),
              edited_by_user = edited_by_user or $7,
              completed_at = case
                when $4::text = 'done' then coalesce(completed_at, now())
                when $4::text = 'open' then null
                else completed_at
              end,
              updated_at = now()
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
        await this.listMeetingsPage({
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
          JSON.stringify(
            input.includedSections ?? [
              "summary",
              "decisions",
              "action_items",
              "transcript",
              "participants",
            ]
          ),
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

        // Leaving `link` revokes every active share in the same transaction.
        if (visibility !== "link") {
          await tx.query(
            `
              update meeting_shares
              set revoked = true, updated_at = now()
              where meeting_id = $1 and revoked = false
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

      await client.query(
        `
          update speakers
          set display_name = $3
          where meeting_id = $1 and label = $2
        `,
        [meetingId, speakerLabel, participant.name]
      )

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
} {
  return {
    async getShareByToken(token) {
      const result = await client.query(
        `
          select s.id, s.meeting_id, s.token, s.visibility, s.revoked,
                 s.expires_at, s.included_sections, s.created_by,
                 s.created_at, s.updated_at,
                 m.workspace_id as meeting_workspace_id
          from meeting_shares s
          join meetings m on m.id = s.meeting_id
          where s.token = $1
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
