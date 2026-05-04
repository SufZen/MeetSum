import { createDelegatedGoogleClient, getWorkspaceSubject } from "@/lib/google/auth"
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/google/workspace"
import { getDatabasePool } from "@/lib/db/client"

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

function createId(prefix: string, stable: string) {
  return `${prefix}_${Buffer.from(stable).toString("base64url").slice(0, 40)}`
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

async function getMeetAccessToken(subject: string) {
  const auth = await createDelegatedGoogleClient(subject, GOOGLE_WORKSPACE_SCOPES.meet)
  const tokenResponse = await auth.getAccessToken()
  const token =
    typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token

  if (!token) throw new Error("Unable to get Google Meet access token")

  return token
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
} = {}): Promise<PersistedMeetConferenceRecord[]> {
  const subject = options.subject ?? getWorkspaceSubject()
  const identityId = await getIdentityId(subject)
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
      group by mcr.id, m.title, ce.title
      order by mcr.start_time desc nulls last, mcr.updated_at desc
      limit $2
    `,
    [identityId, Math.max(1, Math.min(options.limit ?? 10, 50))]
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

export async function listMeetArtifacts(options: {
  subject?: string
  limit?: number
  pageToken?: string
} = {}): Promise<MeetArtifactListResult> {
  const subject = options.subject ?? getWorkspaceSubject()
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50))

  try {
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
