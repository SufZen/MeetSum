import { createHash } from "node:crypto"

import { createDelegatedGoogleClient, getWorkspaceSubject } from "@/lib/google/auth"
import { importDriveRecordings } from "@/lib/google/services"
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/google/workspace"
import { getDatabasePool } from "@/lib/db/client"
import type { TranscriptSegment } from "@/lib/meetings/repository"

type SyncStatus = "idle" | "running" | "completed" | "failed"

type MeetApiRecord = {
  name?: string
  space?: string
  startTime?: string
  endTime?: string
  expireTime?: string
  [key: string]: unknown
}

type MeetApiArtifact = {
  name?: string
  state?: string
  startTime?: string
  endTime?: string
  driveDestination?: { file?: string; exportUri?: string }
  docsDestination?: { document?: string; exportUri?: string }
  [key: string]: unknown
}

type MeetApiTranscriptEntry = {
  name?: string
  participant?: string
  text?: string
  languageCode?: string
  startTime?: string
  endTime?: string
}

export type MeetArtifactType = "recording" | "transcript" | "smart_notes"

export type MeetSetupState = {
  artifactMode: "google-artifacts-first"
  liveCapture: "native-recording-transcript-smart-notes"
  authorized: boolean
  requiredScope: string
  message?: string
}

export type PersistedMeetArtifact = {
  id: string
  artifactType: MeetArtifactType
  artifactName: string
  state?: string
  startTime?: string
  endTime?: string
  driveFileId?: string
  driveFileName?: string
  documentName?: string
}

export type PersistedMeetConferenceRecord = {
  id: string
  conferenceRecordName: string
  meetingId?: string
  meetingTitle?: string
  calendarEventId?: string
  calendarTitle?: string
  spaceName?: string
  startTime?: string
  endTime?: string
  expireTime?: string
  artifacts: PersistedMeetArtifact[]
}

export type MeetTranscriptArtifactCandidate = {
  id: string
  artifactType: Extract<MeetArtifactType, "transcript" | "smart_notes">
  artifactName: string
  conferenceRecordName: string
  conferenceStartTime?: string
  artifactStartTime?: string
  documentName?: string
}

export type MeetTranscriptArtifactImportResult = {
  meetingId: string
  artifactIds: string[]
  transcriptSegments: TranscriptSegment[]
  importedEntries: number
  importedSmartNotes: number
}

export type MeetRecordingArtifactImportResult = {
  meetingId: string
  artifactIds: string[]
  importedFiles: number
  skippedFiles: number
  jobs: unknown[]
  errors: string[]
}

export type MeetArtifactListResult = {
  subject: string
  conferenceRecords: MeetApiRecord[]
  persistedRecords: PersistedMeetConferenceRecord[]
  nextPageToken?: string
  setup: MeetSetupState
}

export type MeetArtifactSyncResult = {
  subject: string
  status: "completed"
  mode: "google-artifacts-first"
  discovered: number
  persisted: number
  recordings: number
  transcripts: number
  smartNotes: number
  linkedMeetings: number
  nextPageToken?: string
  message: string
  records: PersistedMeetConferenceRecord[]
}

const MEET_BASE_URL = "https://meet.googleapis.com/v2"

export function createMeetResourceId(prefix: string, stable: string) {
  return `${prefix}_${createHash("sha256").update(stable).digest("base64url").slice(0, 32)}`
}

function createId(prefix: string, stable: string) {
  return createMeetResourceId(prefix, stable)
}

function createSyncStateId(identityId: string, source: string) {
  return createId("gsync", `${identityId}:${source}`)
}

function setupState(authorized: boolean, message?: string): MeetSetupState {
  return {
    artifactMode: "google-artifacts-first",
    liveCapture: "native-recording-transcript-smart-notes",
    authorized,
    requiredScope: GOOGLE_WORKSPACE_SCOPES.meet[0],
    message,
  }
}

function safeIso(value?: string | null) {
  if (!value) return undefined
  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function safeDate(value?: string | null) {
  if (!value) return undefined
  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? undefined : date
}

function languageFromCode(value?: string) {
  return value?.split("-")[0]?.toLowerCase() || undefined
}

function detectTextLanguage(value: string) {
  return /[\u0590-\u05ff]/.test(value) ? "he" : "en"
}

function transcriptEntryId(value: string | undefined, index: number) {
  const suffix = value?.split("/").filter(Boolean).at(-1) ?? String(index + 1)

  return `meet_entry_${suffix.replace(/[^\w-]+/g, "_")}`
}

function participantLabel(value: string | undefined, index: number) {
  const raw = value?.split("/").filter(Boolean).at(-1)

  if (!raw) return `Speaker ${index + 1}`

  return decodeURIComponent(raw)
    .replace(/[._-]+/g, " ")
    .trim() || `Speaker ${index + 1}`
}

function msFromBase(value: string | undefined, baseMs: number, fallbackMs: number) {
  const date = value ? new Date(value) : undefined
  const time = date && !Number.isNaN(date.getTime()) ? date.getTime() : undefined

  return Math.max(0, time === undefined ? fallbackMs : time - baseMs)
}

export function convertMeetTranscriptEntriesToSegments(
  entries: MeetApiTranscriptEntry[],
  options: { baseTime?: string } = {}
): TranscriptSegment[] {
  const baseDate = options.baseTime ? new Date(options.baseTime) : undefined
  const firstEntryDate = entries[0]?.startTime
    ? new Date(entries[0].startTime)
    : undefined
  const baseMs =
    baseDate && !Number.isNaN(baseDate.getTime())
      ? baseDate.getTime()
      : firstEntryDate && !Number.isNaN(firstEntryDate.getTime())
        ? firstEntryDate.getTime()
        : Date.now()

  return entries
    .filter((entry) => entry.text?.trim())
    .map((entry, index) => {
      const startMs = msFromBase(entry.startTime, baseMs, index * 5000)
      const endMs = Math.max(
        startMs + 1000,
        msFromBase(entry.endTime, baseMs, startMs + 5000)
      )

      return {
        id: transcriptEntryId(entry.name, index),
        speaker: participantLabel(entry.participant, index),
        startMs,
        endMs,
        text: entry.text?.trim() ?? "",
        confidence: 0.95,
        language: languageFromCode(entry.languageCode),
      }
    })
}

export function extractMeetSmartNotesDocumentId(value?: string) {
  if (!value) return undefined

  const documentMatch = value.match(/\/document\/d\/([^/?#]+)/)
  if (documentMatch?.[1]) return documentMatch[1]

  const resourceMatch = value.match(/(?:documents|files)\/([^/?#]+)/)
  if (resourceMatch?.[1]) return resourceMatch[1]

  return undefined
}

export function extractMeetRecordingDriveFileId(value?: string) {
  if (!value) return undefined

  const driveFileMatch = value.match(/\/file\/d\/([^/?#]+)/)
  if (driveFileMatch?.[1]) return driveFileMatch[1]

  const resourceMatch = value.match(/(?:driveFiles|files)\/([^/?#]+)/)
  if (resourceMatch?.[1]) return resourceMatch[1]

  return undefined
}

export function convertMeetSmartNotesTextToSegments(
  text: string,
  options: {
    artifactId: string
    artifactStartTime?: string
  }
): TranscriptSegment[] {
  const chunks = text
    .split(/\n\s*\n/g)
    .map((chunk) =>
      chunk
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n")
    )
    .filter(Boolean)

  return chunks.map((chunk, index) => ({
    id: `meet_smart_note_${options.artifactId.replace(/[^\w-]+/g, "_")}_${index + 1}`,
    speaker: "Google Meet smart notes",
    startMs: index * 4000,
    endMs: (index + 1) * 4000,
    text: chunk,
    confidence: 0.9,
    language: detectTextLanguage(chunk),
  }))
}

export function classifyMeetArtifactType(value: string): MeetArtifactType {
  if (value.includes("/recordings/")) return "recording"
  if (value.includes("/transcripts/")) return "transcript"

  return "smart_notes"
}

function extractDriveGoogleFileId(artifact: MeetApiArtifact) {
  const file = artifact.driveDestination?.file

  if (!file) return undefined

  return file.split("/").filter(Boolean).at(-1)
}

function extractDocumentName(artifact: MeetApiArtifact) {
  return artifact.docsDestination?.document ?? artifact.driveDestination?.file
}

async function getGoogleAccessToken(subject: string, scopes: readonly string[]) {
  const auth = await createDelegatedGoogleClient(subject, scopes)
  const tokenResponse = await auth.getAccessToken()
  const token =
    typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token

  if (!token) throw new Error("Unable to get Google access token")

  return token
}

async function getMeetAccessToken(subject: string) {
  return getGoogleAccessToken(subject, GOOGLE_WORKSPACE_SCOPES.meet)
}

async function getDriveAccessToken(subject: string) {
  return getGoogleAccessToken(subject, GOOGLE_WORKSPACE_SCOPES.drive)
}

async function getIdentityId(subject: string) {
  const pool = getDatabasePool()
  const workspaceAccountId = "workspace_realization"

  await pool.query(
    `
      insert into workspace_accounts (id, domain, admin_email)
      values ($1, $2, $3)
      on conflict (id) do nothing
    `,
    [
      workspaceAccountId,
      subject.split("@")[1] ?? "realization.co.il",
      process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL ?? subject,
    ]
  )

  const identityId = createId("gident", subject)
  await pool.query(
    `
      insert into google_identities (
        id, workspace_account_id, subject_email, sync_enabled
      )
      values ($1, $2, $3, true)
      on conflict (workspace_account_id, subject_email)
      do update set sync_enabled = excluded.sync_enabled
    `,
    [identityId, workspaceAccountId, subject]
  )

  return identityId
}

async function setMeetSyncState(
  subject: string,
  patch: {
    status: SyncStatus
    lastError?: string | null
    stats?: Record<string, unknown>
    nextPollAt?: Date
  }
) {
  const pool = getDatabasePool()
  const identityId = await getIdentityId(subject)
  const id = createSyncStateId(identityId, "meet")

  await pool.query(
    `
      insert into google_sync_states (
        id, google_identity_id, source, status, last_error, last_synced_at,
        next_poll_at, metadata, updated_at
      )
      values ($1, $2, 'meet', $3, $4,
        case when $3 = 'completed' then now() else null end,
        $5,
        $6::jsonb,
        now()
      )
      on conflict (google_identity_id, source)
      do update set
        status = excluded.status,
        last_error = excluded.last_error,
        last_synced_at = case
          when excluded.status = 'completed' then now()
          else google_sync_states.last_synced_at
        end,
        next_poll_at = coalesce(excluded.next_poll_at, google_sync_states.next_poll_at),
        metadata = coalesce(excluded.metadata, google_sync_states.metadata),
        updated_at = now()
    `,
    [
      id,
      identityId,
      patch.status,
      patch.lastError ?? null,
      patch.nextPollAt?.toISOString() ?? null,
      JSON.stringify(patch.stats ?? {}),
    ]
  )
}

async function fetchMeetJson<T>(
  token: string,
  path: string,
  params?: Record<string, string | number | undefined>
) {
  const url = new URL(`${MEET_BASE_URL}/${path}`)

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string }
  }

  if (!response.ok) {
    throw new Error(body.error?.message ?? "Google Meet API request failed")
  }

  return body
}

async function listConferenceRecordsFromGoogle(options: {
  subject: string
  limit: number
  pageToken?: string
}) {
  const token = await getMeetAccessToken(options.subject)
  const body = await fetchMeetJson<{
    conferenceRecords?: MeetApiRecord[]
    nextPageToken?: string
  }>(token, "conferenceRecords", {
    pageSize: Math.max(1, Math.min(options.limit, 50)),
    pageToken: options.pageToken,
  })

  return {
    token,
    conferenceRecords: body.conferenceRecords ?? [],
    nextPageToken: body.nextPageToken,
  }
}

async function listArtifactsForRecord(
  token: string,
  conferenceRecordName: string,
  artifactType: MeetArtifactType
) {
  const resource =
    artifactType === "recording"
      ? "recordings"
      : artifactType === "transcript"
        ? "transcripts"
        : "smartNotes"

  const body = await fetchMeetJson<Record<string, MeetApiArtifact[]>>(
    token,
    `${conferenceRecordName}/${resource}`,
    { pageSize: 20 }
  ).catch(() => ({ [resource]: [] }))

  return body[resource] ?? []
}

async function listTranscriptEntriesForArtifact(
  token: string,
  transcriptArtifactName: string,
  limit = Number(process.env.MEETSUM_MEET_TRANSCRIPT_ENTRY_LIMIT ?? 2000)
) {
  const entries: MeetApiTranscriptEntry[] = []
  let pageToken: string | undefined

  while (entries.length < limit) {
    const body = await fetchMeetJson<{
      transcriptEntries?: MeetApiTranscriptEntry[]
      nextPageToken?: string
    }>(token, `${transcriptArtifactName}/entries`, {
      pageSize: Math.min(100, limit - entries.length),
      pageToken,
    })

    entries.push(...(body.transcriptEntries ?? []))
    pageToken = body.nextPageToken

    if (!pageToken) break
  }

  return entries
}

async function findMeetCalendarMatch(options: {
  identityId: string
  startTime?: string
  endTime?: string
}) {
  const startDate = safeDate(options.startTime)

  if (!startDate) return undefined

  const pool = getDatabasePool()
  const result = await pool.query(
    `
      select ce.id, ce.title, ce.starts_at, m.id as meeting_id
      from calendar_events ce
      left join meetings m on m.calendar_event_id = ce.id
      where ce.google_identity_id = $1
        and ce.starts_at between ($2::timestamptz - interval '4 hours')
                            and (coalesce($3::timestamptz, $2::timestamptz) + interval '4 hours')
        and coalesce(ce.status, '') <> 'cancelled'
      order by abs(extract(epoch from (ce.starts_at - $2::timestamptz))) asc
      limit 1
    `,
    [options.identityId, startDate.toISOString(), safeIso(options.endTime) ?? null]
  )

  return result.rows[0] as
    | { id: string; title: string; meeting_id?: string }
    | undefined
}

async function upsertConferenceRecord(options: {
  identityId: string
  record: MeetApiRecord
}) {
  if (!options.record.name) return undefined

  const pool = getDatabasePool()
  const match = await findMeetCalendarMatch({
    identityId: options.identityId,
    startTime: options.record.startTime,
    endTime: options.record.endTime,
  })
  const id = createId("meetconf", `${options.identityId}:${options.record.name}`)
  const result = await pool.query(
    `
      insert into meet_conference_records (
        id, google_identity_id, conference_record_name, meeting_id,
        calendar_event_id, space_name, start_time, end_time, expire_time, raw,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
      on conflict (conference_record_name)
      do update set
        meeting_id = coalesce(excluded.meeting_id, meet_conference_records.meeting_id),
        calendar_event_id = coalesce(excluded.calendar_event_id, meet_conference_records.calendar_event_id),
        space_name = excluded.space_name,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        expire_time = excluded.expire_time,
        raw = excluded.raw,
        updated_at = now()
      returning id, meeting_id, calendar_event_id
    `,
    [
      id,
      options.identityId,
      options.record.name,
      match?.meeting_id ?? null,
      match?.id ?? null,
      options.record.space ?? null,
      safeIso(options.record.startTime) ?? null,
      safeIso(options.record.endTime) ?? null,
      safeIso(options.record.expireTime) ?? null,
      JSON.stringify(options.record),
    ]
  )

  return result.rows[0] as
    | { id: string; meeting_id?: string; calendar_event_id?: string }
    | undefined
}

async function findDriveFileId(options: {
  identityId: string
  googleFileId?: string
}) {
  if (!options.googleFileId) return undefined

  const result = await getDatabasePool().query(
    `
      select id
      from drive_files
      where google_identity_id = $1 and google_file_id = $2
      limit 1
    `,
    [options.identityId, options.googleFileId]
  )

  return (result.rows[0] as { id?: string } | undefined)?.id
}

async function upsertMeetArtifact(options: {
  identityId: string
  conferenceRecordId: string
  artifactType: MeetArtifactType
  artifact: MeetApiArtifact
}) {
  if (!options.artifact.name) return false

  const googleFileId = extractDriveGoogleFileId(options.artifact)
  const driveFileId = await findDriveFileId({
    identityId: options.identityId,
    googleFileId,
  })
  const id = createId(
    "meetartifact",
    `${options.conferenceRecordId}:${options.artifactType}:${options.artifact.name}`
  )

  await getDatabasePool().query(
    `
      insert into meet_artifacts (
        id, conference_record_id, artifact_type, artifact_name, drive_file_id,
        document_name, state, start_time, end_time, raw, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
      on conflict (conference_record_id, artifact_type, artifact_name)
      do update set
        drive_file_id = coalesce(excluded.drive_file_id, meet_artifacts.drive_file_id),
        document_name = excluded.document_name,
        state = excluded.state,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        raw = excluded.raw,
        updated_at = now()
    `,
    [
      id,
      options.conferenceRecordId,
      options.artifactType,
      options.artifact.name,
      driveFileId ?? null,
      extractDocumentName(options.artifact) ?? null,
      options.artifact.state ?? null,
      safeIso(options.artifact.startTime) ?? null,
      safeIso(options.artifact.endTime) ?? null,
      JSON.stringify(options.artifact),
    ]
  )

  return true
}

export async function listPersistedMeetArtifacts(options: {
  subject?: string
  limit?: number
  meetingId?: string
} = {}): Promise<PersistedMeetConferenceRecord[]> {
  const subject = options.subject ?? getWorkspaceSubject()
  const identityId = await getIdentityId(subject)
  const values: unknown[] = [identityId]
  const meetingFilter = options.meetingId
    ? (() => {
        values.push(options.meetingId)
        return `
          and (
            mcr.meeting_id = $${values.length}
            or mcr.calendar_event_id = (
              select calendar_event_id from meetings where id = $${values.length}
            )
          )
        `
      })()
    : ""
  values.push(Math.max(1, Math.min(options.limit ?? 10, 50)))
  const result = await getDatabasePool().query(
    `
      select
        mcr.id,
        mcr.conference_record_name,
        mcr.meeting_id,
        m.title as meeting_title,
        mcr.calendar_event_id,
        ce.title as calendar_title,
        mcr.space_name,
        mcr.start_time,
        mcr.end_time,
        mcr.expire_time,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', ma.id,
              'artifactType', ma.artifact_type,
              'artifactName', ma.artifact_name,
              'state', ma.state,
              'startTime', ma.start_time,
              'endTime', ma.end_time,
              'driveFileId', ma.drive_file_id,
              'driveFileName', df.name,
              'documentName', ma.document_name
            )
            order by ma.created_at desc
          ) filter (where ma.id is not null),
          '[]'::jsonb
        ) as artifacts
      from meet_conference_records mcr
      left join meet_artifacts ma on ma.conference_record_id = mcr.id
      left join drive_files df on df.id = ma.drive_file_id
      left join meetings m on m.id = mcr.meeting_id
      left join calendar_events ce on ce.id = mcr.calendar_event_id
      where mcr.google_identity_id = $1
        ${meetingFilter}
      group by mcr.id, m.title, ce.title
      order by mcr.start_time desc nulls last, mcr.updated_at desc
      limit $${values.length}
    `,
    values
  )

  return result.rows.map((row) => {
    const record = row as {
      id: string
      conference_record_name: string
      meeting_id?: string | null
      meeting_title?: string | null
      calendar_event_id?: string | null
      calendar_title?: string | null
      space_name?: string | null
      start_time?: Date | string | null
      end_time?: Date | string | null
      expire_time?: Date | string | null
      artifacts: Array<{
        id: string
        artifactType: MeetArtifactType
        artifactName: string
        state?: string | null
        startTime?: string | null
        endTime?: string | null
        driveFileId?: string | null
        driveFileName?: string | null
        documentName?: string | null
      }>
    }

    return {
      id: record.id,
      conferenceRecordName: record.conference_record_name,
      meetingId: record.meeting_id ?? undefined,
      meetingTitle: record.meeting_title ?? undefined,
      calendarEventId: record.calendar_event_id ?? undefined,
      calendarTitle: record.calendar_title ?? undefined,
      spaceName: record.space_name ?? undefined,
      startTime: record.start_time ? new Date(record.start_time).toISOString() : undefined,
      endTime: record.end_time ? new Date(record.end_time).toISOString() : undefined,
      expireTime: record.expire_time
        ? new Date(record.expire_time).toISOString()
        : undefined,
      artifacts: record.artifacts.map((artifact) => ({
        id: artifact.id,
        artifactType: artifact.artifactType,
        artifactName: artifact.artifactName,
        state: artifact.state ?? undefined,
        startTime: artifact.startTime
          ? new Date(artifact.startTime).toISOString()
          : undefined,
        endTime: artifact.endTime
          ? new Date(artifact.endTime).toISOString()
          : undefined,
        driveFileId: artifact.driveFileId ?? undefined,
        driveFileName: artifact.driveFileName ?? undefined,
        documentName: artifact.documentName ?? undefined,
      })),
    }
  })
}

export async function listMeetingTranscriptArtifactCandidates(options: {
  meetingId: string
  artifactIds?: string[]
}): Promise<MeetTranscriptArtifactCandidate[]> {
  const values: unknown[] = [options.meetingId]
  const idFilter =
    options.artifactIds?.length
      ? (() => {
          values.push(options.artifactIds)
          return `and ma.id = any($${values.length}::text[])`
        })()
      : ""
  const result = await getDatabasePool().query(
    `
      select
        ma.id,
        ma.artifact_type,
        ma.artifact_name,
        mcr.conference_record_name,
        mcr.start_time as conference_start_time,
        ma.start_time as artifact_start_time,
        ma.document_name
      from meet_artifacts ma
      join meet_conference_records mcr on mcr.id = ma.conference_record_id
      where ma.artifact_type in ('transcript', 'smart_notes')
        and (
          mcr.meeting_id = $1
          or mcr.calendar_event_id = (
            select calendar_event_id from meetings where id = $1
          )
        )
        ${idFilter}
      order by
        case ma.artifact_type when 'transcript' then 0 else 1 end,
        ma.start_time asc nulls last,
        ma.created_at asc
    `,
    values
  )

  return result.rows.map((row) => {
    const candidate = row as {
      id: string
      artifact_type: "transcript" | "smart_notes"
      artifact_name: string
      conference_record_name: string
      conference_start_time?: string | Date | null
      artifact_start_time?: string | Date | null
      document_name?: string | null
    }

    return {
      id: candidate.id,
      artifactType: candidate.artifact_type,
      artifactName: candidate.artifact_name,
      conferenceRecordName: candidate.conference_record_name,
      conferenceStartTime: candidate.conference_start_time
        ? new Date(candidate.conference_start_time).toISOString()
        : undefined,
      artifactStartTime: candidate.artifact_start_time
        ? new Date(candidate.artifact_start_time).toISOString()
        : undefined,
      documentName: candidate.document_name ?? undefined,
    }
  })
}

export async function listMeetingRecordingArtifactCandidates(options: {
  meetingId: string
  artifactIds?: string[]
}): Promise<
  Array<{
    id: string
    artifactName: string
    driveFileId?: string
  }>
> {
  const values: unknown[] = [options.meetingId]
  const idFilter =
    options.artifactIds?.length
      ? (() => {
          values.push(options.artifactIds)
          return `and ma.id = any($${values.length}::text[])`
        })()
      : ""
  const result = await getDatabasePool().query(
    `
      select
        ma.id,
        ma.artifact_name,
        ma.document_name,
        ma.raw #>> '{driveDestination,file}' as drive_destination_file
      from meet_artifacts ma
      join meet_conference_records mcr on mcr.id = ma.conference_record_id
      where ma.artifact_type = 'recording'
        and (
          mcr.meeting_id = $1
          or mcr.calendar_event_id = (
            select calendar_event_id from meetings where id = $1
          )
        )
        ${idFilter}
      order by ma.start_time asc nulls last, ma.created_at asc
    `,
    values
  )

  return result.rows.map((row) => {
    const candidate = row as {
      id: string
      artifact_name: string
      document_name?: string | null
      drive_destination_file?: string | null
    }

    return {
      id: candidate.id,
      artifactName: candidate.artifact_name,
      driveFileId: extractMeetRecordingDriveFileId(
        candidate.drive_destination_file ?? candidate.document_name ?? undefined
      ),
    }
  })
}

async function fetchDriveTextExport(token: string, fileId: string) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}/export`)
  url.searchParams.set("mimeType", "text/plain")

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string }
    }
    throw new Error(
      body.error?.message ?? "Unable to export Google Meet smart notes document"
    )
  }

  return response.text()
}

export async function importMeetRecordingArtifactsForMeeting(options: {
  subject?: string
  meetingId: string
  artifactIds?: string[]
}): Promise<MeetRecordingArtifactImportResult> {
  const subject = options.subject ?? getWorkspaceSubject()
  const candidates = await listMeetingRecordingArtifactCandidates({
    meetingId: options.meetingId,
    artifactIds: options.artifactIds,
  })
  const artifactIds = candidates.map((candidate) => candidate.id)
  const driveFileIds = [
    ...new Set(
      candidates
        .map((candidate) => candidate.driveFileId)
        .filter((fileId): fileId is string => Boolean(fileId))
    ),
  ]

  if (!driveFileIds.length) {
    throw new Error(
      "No importable Google Drive recording file is linked to this Meet recording artifact yet."
    )
  }

  const imported = await importDriveRecordings(subject, driveFileIds, {
    preferredMeetingId: options.meetingId,
  })

  return {
    meetingId: options.meetingId,
    artifactIds,
    importedFiles: imported.imported,
    skippedFiles: imported.skipped,
    jobs: imported.jobs,
    errors: imported.errors,
  }
}

export async function importMeetTranscriptArtifactsForMeeting(options: {
  subject?: string
  meetingId: string
  artifactIds?: string[]
}): Promise<MeetTranscriptArtifactImportResult> {
  const subject = options.subject ?? getWorkspaceSubject()
  const candidates = await listMeetingTranscriptArtifactCandidates({
    meetingId: options.meetingId,
    artifactIds: options.artifactIds,
  })

  if (!candidates.length) {
    throw new Error(
      "No Google Meet transcript or smart notes artifacts are linked to this meeting yet. Sync Meet artifacts first or import the Drive recording."
    )
  }

  const meetToken = await getMeetAccessToken(subject)
  let driveToken: string | undefined
  const transcriptSegments: TranscriptSegment[] = []
  let importedEntries = 0
  let importedSmartNotes = 0

  for (const candidate of candidates) {
    const baseTime = candidate.conferenceStartTime ?? candidate.artifactStartTime

    if (candidate.artifactType === "transcript") {
      const entries = await listTranscriptEntriesForArtifact(
        meetToken,
        candidate.artifactName
      )
      const segments = convertMeetTranscriptEntriesToSegments(entries, {
        baseTime,
      })

      importedEntries += segments.length
      transcriptSegments.push(...segments)
      continue
    }

    const documentId = extractMeetSmartNotesDocumentId(candidate.documentName)

    if (!documentId) continue

    driveToken ??= await getDriveAccessToken(subject)
    const text = await fetchDriveTextExport(driveToken, documentId)
    const segments = convertMeetSmartNotesTextToSegments(text, {
      artifactId: candidate.id,
      artifactStartTime: baseTime,
    })

    importedSmartNotes += segments.length
    transcriptSegments.push(...segments)
  }

  if (!transcriptSegments.length) {
    throw new Error(
      "Google Meet returned artifacts, but no transcript entries or smart notes text were available yet."
    )
  }

  return {
    meetingId: options.meetingId,
    artifactIds: candidates.map((candidate) => candidate.id),
    transcriptSegments: transcriptSegments.sort((a, b) => a.startMs - b.startMs),
    importedEntries,
    importedSmartNotes,
  }
}

export async function listMeetArtifacts(options: {
  subject?: string
  limit?: number
  pageToken?: string
  meetingId?: string
} = {}): Promise<MeetArtifactListResult> {
  const subject = options.subject ?? getWorkspaceSubject()
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50))

  try {
    if (options.meetingId) {
      return {
        subject,
        conferenceRecords: [],
        persistedRecords: await listPersistedMeetArtifacts({
          subject,
          limit,
          meetingId: options.meetingId,
        }),
        setup: setupState(true),
      }
    }

    const live = await listConferenceRecordsFromGoogle({
      subject,
      limit,
      pageToken: options.pageToken,
    })
    const persistedRecords = await listPersistedMeetArtifacts({
      subject,
      limit: 10,
    })

    return {
      subject,
      conferenceRecords: live.conferenceRecords,
      persistedRecords,
      nextPageToken: live.nextPageToken,
      setup: setupState(true),
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list Google Meet artifacts"

    return {
      subject,
      conferenceRecords: [],
      persistedRecords: await listPersistedMeetArtifacts({
        subject,
        limit: 10,
        meetingId: options.meetingId,
      }).catch(() => []),
      setup: setupState(false, message),
    }
  }
}

export async function syncMeetArtifacts(options: {
  subject?: string
  limit?: number
} = {}): Promise<MeetArtifactSyncResult> {
  const subject = options.subject ?? getWorkspaceSubject()
  const limit = Math.max(1, Math.min(options.limit ?? 10, 25))

  await setMeetSyncState(subject, { status: "running" })

  const stats = {
    source: "meet",
    discovered: 0,
    persisted: 0,
    recordings: 0,
    transcripts: 0,
    smartNotes: 0,
    linkedMeetings: 0,
  }

  try {
    const identityId = await getIdentityId(subject)
    const live = await listConferenceRecordsFromGoogle({ subject, limit })

    for (const record of live.conferenceRecords) {
      if (!record.name) continue

      stats.discovered += 1
      const persisted = await upsertConferenceRecord({ identityId, record })

      if (!persisted) continue

      stats.persisted += 1
      if (persisted.meeting_id) stats.linkedMeetings += 1

      for (const artifactType of [
        "recording",
        "transcript",
        "smart_notes",
      ] as const) {
        const artifacts = await listArtifactsForRecord(
          live.token,
          record.name,
          artifactType
        )

        for (const artifact of artifacts) {
          const inserted = await upsertMeetArtifact({
            identityId,
            conferenceRecordId: persisted.id,
            artifactType,
            artifact,
          })

          if (!inserted) continue
          if (artifactType === "recording") stats.recordings += 1
          if (artifactType === "transcript") stats.transcripts += 1
          if (artifactType === "smart_notes") stats.smartNotes += 1
        }
      }
    }

    await setMeetSyncState(subject, {
      status: "completed",
      stats,
      nextPollAt: new Date(Date.now() + 30 * 60 * 1000),
    })

    const records = await listPersistedMeetArtifacts({ subject, limit: 10 })

    return {
      subject,
      status: "completed",
      mode: "google-artifacts-first",
      discovered: stats.discovered,
      persisted: stats.persisted,
      recordings: stats.recordings,
      transcripts: stats.transcripts,
      smartNotes: stats.smartNotes,
      linkedMeetings: stats.linkedMeetings,
      nextPageToken: live.nextPageToken,
      message:
        stats.discovered > 0
          ? `Meet artifact sync found ${stats.discovered} conference records and ${stats.recordings + stats.transcripts + stats.smartNotes} artifacts.`
          : "Meet artifact access is working, but no conference records were returned yet.",
      records,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to sync Meet artifacts"

    await setMeetSyncState(subject, {
      status: "failed",
      lastError: message,
      stats: { ...stats, error: message },
      nextPollAt: new Date(Date.now() + 30 * 60 * 1000),
    })
    throw error
  }
}
