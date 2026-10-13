import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"

import { google } from "googleapis"

import { FFMPEG_INPUT_PROTOCOLS } from "@/lib/ai/asr/audio"
import { hasConferenceLink } from "@/lib/bot/calendar-links"
import { cancelCalendarBotSession, syncCalendarBotSession } from "@/lib/bot/calendar-sync"
import { getBotConfig, isBotEnabled } from "@/lib/bot/config"
import { redactBotError } from "@/lib/bot/redact"
import type { CalendarEventLike } from "@/lib/bot/types"
import { getDatabasePool } from "@/lib/db/client"
import { createDelegatedGoogleClient } from "@/lib/google/auth"
import { findCanonicalMeetingId } from "@/lib/integrations/microsoft/calendar-dedupe"
import {
  ensureGoogleIdentity,
  type GoogleWorkspaceTarget,
} from "@/lib/google/identity"
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/google/workspace"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import type {
  MeetingRecord,
  MeetingRepository,
  RepoScope,
} from "@/lib/meetings/repository"
import {
  getScopedMeetingRepository,
  getSystemMeetingRepository,
} from "@/lib/meetings/store"
import { meetingScopeSql } from "@/lib/meetings/visibility"
import { getAppSettings, type AppSettings } from "@/lib/settings/app-settings"
import { storeMeetingObject } from "@/lib/storage/object-storage"

export type { GoogleWorkspaceTarget } from "@/lib/google/identity"

const execFileAsync = promisify(execFile)

/**
 * Language for meetings created by Google imports: an explicit workspace
 * language wins; "auto" keeps the historical `mixed` (detect per meeting).
 */
export function importedMeetingLanguage(
  settings: Pick<AppSettings, "meetingLanguageMode">
) {
  return settings.meetingLanguageMode === "auto"
    ? "mixed"
    : settings.meetingLanguageMode
}

/** Workspace-level effects every Google import applies (C6). */
type ImportSettings = Pick<
  AppSettings,
  | "autoProcessImportedMedia"
  | "retainVideoByDefault"
  | "meetingLanguageMode"
  | "defaultMeetingVisibility"
>

async function loadImportSettings(workspaceId: string): Promise<ImportSettings> {
  return getAppSettings(workspaceId)
}

type GoogleSource = "calendar" | "drive" | "gmail"
type SyncStatus = "idle" | "running" | "completed" | "failed"

type SyncStats = {
  source: GoogleSource
  created?: number
  updated?: number
  cancelled?: number
  discovered?: number
  matched?: number
  imported?: number
  skipped?: number
  errors?: string[]
  status?: string
}

type CalendarCursor = Record<string, string>

export type DriveRecordingCandidate = {
  fileId: string
  name: string
  mimeType?: string
  sizeBytes?: number
  createdTime?: string
  modifiedTime?: string
  webViewLink?: string
  status: "available" | "imported" | "processing" | "failed"
  imported: boolean
  importedMeetingId?: string
  meetingId?: string
  jobId?: string
  artifactHints: string[]
  bestCalendarMatch?: {
    calendarEventId: string
    meetingId?: string
    title: string
    matchMethod: string
    confidence: number
  }
}

export type DriveRecordingListResult = {
  recordings: DriveRecordingCandidate[]
  nextCursor?: string
}

export type DriveRecordingImportFileResult = {
  fileId: string
  name?: string
  status: "imported" | "already_imported" | "queued" | "skipped" | "failed"
  meetingId?: string
  jobId?: string
  error?: string
}

export type DriveRecordingImportResult = {
  imported: number
  skipped: number
  matched: number
  jobs: Awaited<ReturnType<typeof enqueueMeetSumJob>>[]
  errors: string[]
  files: DriveRecordingImportFileResult[]
}

function createHashedId(prefix: string, stable: string) {
  return `${prefix}_${createHash("sha256").update(stable).digest("hex").slice(0, 32)}`
}

function createSyncStateId(identityId: string, source: GoogleSource) {
  return `sync_${createHash("sha256")
    .update(`${identityId}:${source}`)
    .digest("hex")
    .slice(0, 32)}`
}

function safeDate(value?: string | null) {
  if (!value) return undefined
  const time = new Date(value).getTime()

  return Number.isFinite(time) ? new Date(time) : undefined
}

function eventDateTime(value?: { date?: string | null; dateTime?: string | null }) {
  return value?.dateTime ?? value?.date ?? undefined
}

function parseCursor(value?: string | null): CalendarCursor {
  if (!value) return {}

  try {
    const parsed = JSON.parse(value)

    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function envBoolean(name: string, fallback = false) {
  const value = process.env[name]

  if (value === undefined) return fallback

  return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

function envInt(name: string, fallback: number) {
  const value = Number(process.env[name])

  return Number.isFinite(value) ? value : fallback
}

function splitEnvList(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

const defaultExcludedCalendarPatterns = [
  "birthday",
  "birthdays",
  "holiday",
  "holidays",
  "reminder",
  "reminders",
  "task",
  "tasks",
]

const defaultExcludedTitlePatterns = [
  "break",
  "brunch",
  "dinner",
  "gym",
  "lunch",
  "me time",
  "sleep",
  "workout",
]

function matchesPattern(value: string, patterns: string[]) {
  const normalized = value.toLowerCase()

  return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()))
}

function isAllDayEvent(event: { start?: { date?: string | null; dateTime?: string | null } }) {
  return Boolean(event.start?.date && !event.start?.dateTime)
}

function extractMeetLink(event: {
  hangoutLink?: string | null
  conferenceData?: { entryPoints?: Array<{ uri?: string | null }> }
}) {
  return event.hangoutLink ?? event.conferenceData?.entryPoints?.[0]?.uri ?? null
}

type CalendarAttendee = {
  email?: string | null
  displayName?: string | null
  responseStatus?: string | null
  organizer?: boolean | null
  self?: boolean | null
}

function normalizeAttendanceStatus(
  value?: string | null
): "accepted" | "declined" | "tentative" | "needs_action" | "unknown" {
  if (value === "accepted" || value === "declined" || value === "tentative") {
    return value
  }
  if (value === "needsAction") return "needs_action"
  return "unknown"
}

function calendarParticipants(event: {
  organizer?: { email?: string | null; displayName?: string | null } | null
  attendees?: CalendarAttendee[] | null
}) {
  const byEmailOrName = new Map<
    string,
    {
      name: string
      email?: string
      role: "organizer" | "attendee"
      attendanceStatus: "accepted" | "declined" | "tentative" | "needs_action" | "unknown"
    }
  >()

  const organizerEmail = event.organizer?.email ?? undefined
  // M7: the bot's own Google account is never a meeting participant.
  const botAccountEmail = getBotConfig().accountEmail
  const organizerName =
    event.organizer?.displayName ?? organizerEmail?.split("@")[0] ?? undefined

  if (organizerName || organizerEmail) {
    byEmailOrName.set((organizerEmail ?? organizerName ?? "organizer").toLowerCase(), {
      name: organizerName ?? organizerEmail ?? "Organizer",
      email: organizerEmail,
      role: "organizer",
      attendanceStatus: "unknown",
    })
  }

  for (const attendee of event.attendees ?? []) {
    const email = attendee.email ?? undefined
    const name = attendee.displayName ?? email?.split("@")[0] ?? undefined

    if (!name && !email) continue
    if (botAccountEmail && email?.toLowerCase() === botAccountEmail) continue

    byEmailOrName.set((email ?? name ?? "").toLowerCase(), {
      name: name ?? email ?? "Attendee",
      email,
      role: attendee.organizer || email === organizerEmail ? "organizer" : "attendee",
      attendanceStatus: normalizeAttendanceStatus(attendee.responseStatus),
    })
  }

  return [...byEmailOrName.values()]
}

async function upsertMeetingParticipantsFromCalendar(options: {
  meetingId: string
  event: {
    organizer?: { email?: string | null; displayName?: string | null } | null
    attendees?: CalendarAttendee[] | null
  }
}) {
  const pool = getDatabasePool()
  const participants = calendarParticipants(options.event)

  for (const participant of participants) {
    const stable = `${options.meetingId}:${participant.email ?? participant.name}`

    await pool.query(
      `
        insert into meeting_participants (
          id, meeting_id, name, email, role, source, attendance_status,
          confidence
        )
        values ($1, $2, $3, $4, $5, 'calendar', $6, 0.9)
        on conflict (id) do update set
          name = excluded.name,
          email = excluded.email,
          role = excluded.role,
          source = excluded.source,
          attendance_status = excluded.attendance_status,
          confidence = excluded.confidence,
          updated_at = now()
      `,
      [
        createHashedId("participant", stable),
        options.meetingId,
        participant.name,
        participant.email ?? null,
        participant.role,
        participant.attendanceStatus,
      ]
    )
  }

  return participants
}

function shouldSkipCalendar(
  item: { id?: string | null; summary?: string | null },
  importAll: boolean
) {
  if (importAll) return false

  const patterns = [
    ...defaultExcludedCalendarPatterns,
    ...splitEnvList("MEETSUM_CALENDAR_EXCLUDED_CALENDAR_PATTERNS"),
  ]
  const searchable = `${item.summary ?? ""} ${item.id ?? ""}`

  return matchesPattern(searchable, patterns)
}

function shouldImportCalendarEvent(
  event: {
    status?: string | null
    summary?: string | null
    attendees?: unknown[] | null
    start?: { date?: string | null; dateTime?: string | null }
    hangoutLink?: string | null
    conferenceData?: { entryPoints?: Array<{ uri?: string | null }> }
  },
  importAll: boolean
) {
  if (importAll || event.status === "cancelled") return true

  // M7: Zoom/Teams-only events count as meetings once the bot is enabled
  // (gated so calendar import is unchanged while MEETSUM_BOT_ENABLED is off).
  const hasMeetingSignal =
    Boolean(extractMeetLink(event)) ||
    (isBotEnabled() && hasConferenceLink(event as CalendarEventLike)) ||
    Boolean(event.attendees?.length)

  if (!hasMeetingSignal) return false
  if (isAllDayEvent(event)) return false

  const excludedTitlePatterns = [
    ...defaultExcludedTitlePatterns,
    ...splitEnvList("MEETSUM_CALENDAR_EXCLUDED_TITLE_PATTERNS"),
  ]

  return !matchesPattern(event.summary ?? "", excludedTitlePatterns)
}

function normalizeTitle(value: string) {
  return value
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b(google meet|meet recording|recording|meeting)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function titleScore(a: string, b: string) {
  const left = new Set(normalizeTitle(a).split(" ").filter((word) => word.length > 2))
  const right = new Set(normalizeTitle(b).split(" ").filter((word) => word.length > 2))

  if (!left.size || !right.size) return 0

  let common = 0
  for (const word of left) {
    if (right.has(word)) common += 1
  }

  return common / Math.max(left.size, right.size)
}

function isLikelyMeetRecording(name: string, mimeType?: string | null) {
  const normalized = name.toLowerCase()

  return (
    /meet|recording|פגישה|הקלט|הקלטה/.test(normalized) &&
    (mimeType?.startsWith("video/") || mimeType?.startsWith("audio/"))
  )
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

function normalizeDriveFileIds(fileIds: string[]) {
  return [...new Set(fileIds.map((fileId) => fileId.trim()).filter(Boolean))]
}

export function validateDriveImportFileIds(fileIds: unknown) {
  if (!Array.isArray(fileIds)) {
    throw new Error("fileIds must be an array")
  }

  const normalized = normalizeDriveFileIds(
    fileIds.filter((fileId): fileId is string => typeof fileId === "string")
  )

  if (!normalized.length) {
    throw new Error("Select at least one Drive recording")
  }

  if (normalized.length > 5) {
    throw new Error("Import at most 5 Drive recordings at a time")
  }

  return normalized
}

function safeTempFilename(filename: string | undefined, fallback: string) {
  return (filename ?? fallback).replace(/[^\w. -]+/g, "_")
}

async function extractAudio(inputPath: string, outputPath: string) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      ...FFMPEG_INPUT_PROTOCOLS,
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      outputPath,
    ],
    {
      maxBuffer: 1024 * 1024 * 8,
      timeout: Number(process.env.MEETSUM_FFMPEG_TIMEOUT_MS ?? 900_000),
    }
  )
}

type PreparedDriveMedia = {
  bytes: Buffer
  filename: string
  contentType: string
  retention: "audio"
  /** The untouched video, present only when the workspace keeps videos. */
  original?: {
    bytes: Buffer
    filename: string
    contentType: string
    retention: "video"
  }
}

export async function prepareDriveMediaForStorage(options: {
  drive: ReturnType<typeof google.drive>
  fileId: string
  fileName: string
  mimeType?: string | null
  /** retainVideoByDefault: also keep the original video next to the audio. */
  keepVideo?: boolean
}): Promise<PreparedDriveMedia> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "meetsum-drive-"))

  try {
    const inputPath = path.join(
      tempDir,
      safeTempFilename(options.fileName, `${options.fileId}.media`)
    )
    const response = await options.drive.files.get(
      { fileId: options.fileId, alt: "media", supportsAllDrives: true },
      { responseType: "stream" }
    )

    await pipeline(
      response.data as NodeJS.ReadableStream,
      createWriteStream(inputPath)
    )

    if (options.mimeType?.startsWith("video/")) {
      const audioPath = path.join(tempDir, `${options.fileId}.m4a`)
      await extractAudio(inputPath, audioPath)

      return {
        bytes: await readFile(audioPath),
        filename: options.fileName.replace(/\.[^.]+$/, "") + ".m4a",
        contentType: "audio/mp4",
        retention: "audio" as const,
        original: options.keepVideo
          ? {
              bytes: await readFile(inputPath),
              filename: options.fileName,
              contentType: options.mimeType,
              retention: "video" as const,
            }
          : undefined,
      }
    }

    return {
      bytes: await readFile(inputPath),
      filename: options.fileName,
      contentType: options.mimeType ?? "application/octet-stream",
      retention: "audio" as const,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

type DbClient = { query: ReturnType<typeof getDatabasePool>["query"] }

/**
 * Stores a prepared Drive recording for a workspace meeting: the optional
 * original video first (retention "video"), then the audio the pipeline
 * processes, both tagged with the Drive file id. Returns the audio object.
 */
async function storeDriveMedia(options: {
  db: DbClient
  repo: MeetingRepository
  meetingId: string
  fileId: string
  media: PreparedDriveMedia
}) {
  const { db, repo, meetingId, fileId, media } = options
  const store = async (item: {
    bytes: Buffer
    filename: string
    contentType: string
    retention: "audio" | "video"
  }) => {
    const stored = await storeMeetingObject({
      meetingId,
      filename: item.filename,
      contentType: item.contentType,
      bytes: item.bytes,
    })
    const checksum = createHash("sha256").update(item.bytes).digest("hex")

    await repo.createMediaAsset({
      meetingId,
      storageKey: stored.key,
      filename: item.filename,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
      retention: item.retention,
    })
    await db.query(
      `
        update media_assets
        set source = 'google_drive',
            source_file_id = $2,
            checksum_sha256 = $4
        where meeting_id = $1 and storage_key = $3
      `,
      [meetingId, fileId, stored.key, checksum]
    )

    return stored
  }

  if (media.original) await store(media.original)

  return store(media)
}

/**
 * Finds or creates the workspace meeting a Drive recording belongs to.
 * `visibleRepo` is scoped to the caller: an explicitly preferred meeting must
 * be visible to them (else undefined), and a calendar-matched meeting is only
 * reused when visible; otherwise a new meeting is created, so a recording is
 * never attached to (and re-transcribed into) a private meeting the caller
 * cannot see.
 */
async function resolveDriveImportMeeting(options: {
  repo: MeetingRepository
  visibleRepo: MeetingRepository
  settings: ImportSettings
  preferredMeetingId?: string
  matchedMeetingId?: string | null
  title: string
  startedAt: string
  ownerUserId?: string
}): Promise<MeetingRecord | undefined> {
  if (options.preferredMeetingId) {
    return options.visibleRepo.getMeeting(options.preferredMeetingId)
  }

  if (options.matchedMeetingId) {
    const matched = await options.visibleRepo.getMeeting(options.matchedMeetingId)

    if (matched) return matched
  }

  return options.repo.createMeeting({
    title: options.title,
    source: "google_meet",
    language: importedMeetingLanguage(options.settings),
    startedAt: options.startedAt,
    participants: [],
    ownerUserId: options.ownerUserId,
    visibility: options.settings.defaultMeetingVisibility,
  })
}

async function getIdentityId(target: GoogleWorkspaceTarget) {
  return ensureGoogleIdentity(target)
}

async function getSyncCursor(target: GoogleWorkspaceTarget, source: GoogleSource) {
  const pool = getDatabasePool()
  const identityId = await getIdentityId(target)
  const result = await pool.query(
    `
      select cursor_value
      from google_sync_states
      where google_identity_id = $1 and source = $2
      limit 1
    `,
    [identityId, source]
  )

  return (result.rows[0] as { cursor_value?: string } | undefined)?.cursor_value
}

async function setSyncState(
  target: GoogleWorkspaceTarget,
  source: GoogleSource,
  patch: {
    status: SyncStatus
    cursorValue?: string
    lastError?: string | null
    stats?: SyncStats
    nextPollAt?: Date
  }
) {
  const pool = getDatabasePool()
  const identityId = await getIdentityId(target)
  const id = createSyncStateId(identityId, source)

  await pool.query(
    `
      insert into google_sync_states (
        id, google_identity_id, source, cursor_value, status, last_error,
        last_synced_at, next_poll_at, metadata, updated_at
      )
      values ($1, $2, $3, $4, $5, $6,
        case when $5 = 'completed' then now() else null end,
        $7,
        $8::jsonb,
        now()
      )
      on conflict (google_identity_id, source)
      do update set
        cursor_value = coalesce(excluded.cursor_value, google_sync_states.cursor_value),
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
      source,
      patch.cursorValue ?? null,
      patch.status,
      patch.lastError ?? null,
      patch.nextPollAt?.toISOString() ?? null,
      JSON.stringify(patch.stats ?? {}),
    ]
  )
}

/** Visibility scope for a Google target: the caller's, else system scope. */
function targetScope(target: GoogleWorkspaceTarget, scope?: RepoScope): RepoScope {
  if (scope && scope.workspaceId !== target.workspaceId) {
    throw new Error("Visibility scope does not match the Google workspace target")
  }

  return scope ?? { kind: "system", workspaceId: target.workspaceId }
}

/**
 * Calendar event best matching a Drive file. Only meetings visible to `scope`
 * are joined, and calendar events linked to a meeting the caller cannot see
 * are skipped entirely (their title would reveal the private meeting).
 */
async function findMatchingCalendarEvent(options: {
  identityId: string
  scope: RepoScope
  fileName: string
  fileTime?: Date
}) {
  if (!options.fileTime) return undefined

  const pool = getDatabasePool()
  const values: unknown[] = [options.identityId, options.fileTime.toISOString()]
  const visible = meetingScopeSql(options.scope, "m", values)
  let hidden = ""

  if (options.scope.kind !== "system") {
    values.push(options.scope.workspaceId)
    const workspaceParam = `$${values.length}`

    hidden = `
        and not exists (
          select 1 from meetings mh
          where mh.calendar_event_id = ce.id
            and mh.workspace_id = ${workspaceParam}
            and not coalesce(${meetingScopeSql(options.scope, "mh", values)}, false)
        )`
  }

  const result = await pool.query(
    `
      select ce.id, ce.title, ce.starts_at, m.id as meeting_id
      from calendar_events ce
      left join meetings m on m.calendar_event_id = ce.id
        and ${visible}
      where ce.google_identity_id = $1
        and ce.starts_at between ($2::timestamptz - interval '12 hours')
                            and ($2::timestamptz + interval '12 hours')
        and coalesce(ce.status, '') <> 'cancelled'
        ${hidden}
      order by abs(extract(epoch from (ce.starts_at - $2::timestamptz))) asc
      limit 20
    `,
    values
  )

  let best:
    | {
        id: string
        title: string
        meeting_id?: string | null
        matchMethod: string
        confidence: number
      }
    | undefined

  for (const row of result.rows as Array<{
    id: string
    title: string
    starts_at: string | Date
    meeting_id: string | null
  }>) {
    const startsAt = row.starts_at instanceof Date ? row.starts_at : new Date(row.starts_at)
    const hoursDelta =
      Math.abs(startsAt.getTime() - options.fileTime.getTime()) / 1000 / 60 / 60
    const timeScore = Math.max(0, 1 - hoursDelta / 12)
    const score = Math.max(timeScore * 0.72, titleScore(options.fileName, row.title))

    if (!best || score > best.confidence) {
      best = {
        id: row.id,
        title: row.title,
        meeting_id: row.meeting_id,
        matchMethod: titleScore(options.fileName, row.title) > 0.25 ? "title_time" : "time_window",
        confidence: Number(score.toFixed(2)),
      }
    }
  }

  return best && best.confidence >= 0.35 ? best : undefined
}

async function getDriveImportStatus(options: {
  identityId: string
  scope: RepoScope
  googleFileId: string
}) {
  const pool = getDatabasePool()
  const values: unknown[] = [options.identityId, options.googleFileId]
  const visible = meetingScopeSql(options.scope, "m", values)
  values.push(options.scope.workspaceId)
  const workspaceParam = `$${values.length}`
  const result = await pool.query(
    `
      select
        df.imported_at,
        mdf.meeting_id,
        j.id as job_id,
        j.status as job_status
      from drive_files df
      left join meeting_drive_files mdf on mdf.drive_file_id = df.id
        and mdf.meeting_id in (select m.id from meetings m where ${visible})
      left join jobs j on j.meeting_id = mdf.meeting_id
        and j.workspace_id = ${workspaceParam}
        and j.name in ('media.ingest', 'meeting.transcribe', 'meeting.summarize', 'meeting.index')
        and j.status in ('completed', 'queued', 'active', 'failed')
      where df.google_identity_id = $1 and df.google_file_id = $2
      order by
        case j.status when 'completed' then 0 when 'active' then 1 when 'queued' then 2 when 'failed' then 3 else 4 end,
        j.created_at desc nulls last
      limit 1
    `,
    values
  )
  const row = result.rows[0] as
    | {
        imported_at?: string | Date | null
        meeting_id?: string | null
        job_id?: string | null
        job_status?: string | null
      }
    | undefined
  const status: DriveRecordingCandidate["status"] =
    row?.job_status === "completed"
      ? "imported"
      : row?.job_status === "failed"
      ? "failed"
      : row?.job_status === "queued" || row?.job_status === "active"
        ? "processing"
        : row?.imported_at
          ? "imported"
          : "available"

  return {
    imported: Boolean(row?.imported_at),
    importedMeetingId: row?.meeting_id ?? undefined,
    meetingId: row?.meeting_id ?? undefined,
    jobId: row?.job_id ?? undefined,
    status,
  }
}

async function upsertDriveFileMetadata(options: {
  identityId: string
  googleFileId: string
  name: string
  mimeType?: string | null
  webViewLink?: string | null
  createdTime?: string | null
  modifiedTime?: string | null
  size?: string | number | null
  calendarEventId?: string | null
  raw: unknown
}) {
  const pool = getDatabasePool()
  const proposedDriveFileId = createHashedId(
    "gdrive",
    `${options.identityId}:${options.googleFileId}`
  )
  const driveFileResult = await pool.query(
    `
      insert into drive_files (
        id, google_identity_id, google_file_id, name, mime_type,
        web_view_link, created_time, modified_time, size_bytes,
        calendar_event_id, raw
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      on conflict (google_identity_id, google_file_id)
      do update set
        name = excluded.name,
        mime_type = excluded.mime_type,
        web_view_link = excluded.web_view_link,
        modified_time = excluded.modified_time,
        size_bytes = excluded.size_bytes,
        calendar_event_id = coalesce(excluded.calendar_event_id, drive_files.calendar_event_id),
        raw = excluded.raw
      returning id
    `,
    [
      proposedDriveFileId,
      options.identityId,
      options.googleFileId,
      options.name,
      options.mimeType ?? null,
      options.webViewLink ?? null,
      options.createdTime ?? null,
      options.modifiedTime ?? null,
      options.size ? Number(options.size) : null,
      options.calendarEventId ?? null,
      JSON.stringify(options.raw),
    ]
  )

  return (
    (driveFileResult.rows[0] as { id?: string } | undefined)?.id ??
    proposedDriveFileId
  )
}

export async function listDriveRecordings(
  target: GoogleWorkspaceTarget,
  options: {
    limit?: number
    cursor?: string
    query?: string
    includeImported?: boolean
    /** Caller's visibility scope (defaults to system scope). */
    scope?: RepoScope
  } = {}
): Promise<DriveRecordingListResult> {
  const { subject } = target
  const scope = targetScope(target, options.scope)
  const auth = await createDelegatedGoogleClient(subject, GOOGLE_WORKSPACE_SCOPES.drive)
  const drive = google.drive({ version: "v3", auth })
  const identityId = await getIdentityId(target)
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 25), 50))
  const queryParts = [
    "trashed = false",
    "(mimeType contains 'video/' or mimeType contains 'audio/')",
  ]

  if (options.query?.trim()) {
    queryParts.push(`name contains '${escapeDriveQueryValue(options.query.trim())}'`)
  }

  const recordings: DriveRecordingCandidate[] = []
  let nextCursor = options.cursor

  for (let pagesScanned = 0; pagesScanned < 5 && recordings.length < limit; pagesScanned++) {
    const response = await drive.files.list({
      pageSize: 100,
      pageToken: nextCursor,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields:
        "nextPageToken,files(id,name,mimeType,webViewLink,createdTime,modifiedTime,size,videoMediaMetadata)",
      q: queryParts.join(" and "),
      orderBy: "modifiedTime desc",
    })

    nextCursor = response.data.nextPageToken ?? undefined

    for (const file of response.data.files ?? []) {
      if (recordings.length >= limit) break
      if (!file.id || !file.name || !isLikelyMeetRecording(file.name, file.mimeType)) {
        continue
      }

      const importStatus = await getDriveImportStatus({
        identityId,
        scope,
        googleFileId: file.id,
      })

      if (
        importStatus.imported &&
        importStatus.status === "imported" &&
        options.includeImported !== true
      ) {
        continue
      }

      const match = await findMatchingCalendarEvent({
        identityId,
        scope,
        fileName: file.name,
        fileTime: safeDate(file.createdTime ?? file.modifiedTime),
      })

      recordings.push({
        fileId: file.id,
        name: file.name,
        mimeType: file.mimeType ?? undefined,
        sizeBytes: file.size ? Number(file.size) : undefined,
        createdTime: file.createdTime ?? undefined,
        modifiedTime: file.modifiedTime ?? undefined,
        webViewLink: file.webViewLink ?? undefined,
        status: importStatus.status,
        imported: importStatus.imported,
        importedMeetingId: importStatus.importedMeetingId,
        meetingId: importStatus.meetingId,
        jobId: importStatus.jobId,
        artifactHints: [
          file.mimeType?.startsWith("video/") ? "recording" : "audio",
          match ? "calendar-match" : "needs-review",
        ],
        bestCalendarMatch: match
          ? {
              calendarEventId: match.id,
              meetingId: match.meeting_id ?? undefined,
              title: match.title,
              matchMethod: match.matchMethod,
              confidence: match.confidence,
            }
          : undefined,
      })
    }

    if (!nextCursor) break
  }

  return {
    recordings,
    nextCursor,
  }
}

export async function importDriveRecordings(
  target: GoogleWorkspaceTarget,
  fileIds: string[],
  options: {
    preferredMeetingId?: string
    ownerUserId?: string
    /** Caller's visibility scope (defaults to system scope). */
    scope?: RepoScope
  } = {}
): Promise<DriveRecordingImportResult> {
  const { subject, workspaceId } = target
  const scope = targetScope(target, options.scope)
  const selectedFileIds = validateDriveImportFileIds(fileIds)
  const auth = await createDelegatedGoogleClient(subject, GOOGLE_WORKSPACE_SCOPES.drive)
  const drive = google.drive({ version: "v3", auth })
  const pool = getDatabasePool()
  const repo = getSystemMeetingRepository(workspaceId)
  const visibleRepo =
    scope.kind === "system" ? repo : getScopedMeetingRepository(scope)
  const settings = await loadImportSettings(workspaceId)
  const identityId = await getIdentityId(target)
  const maxImportBytes = Number(
    process.env.MEETSUM_DRIVE_MAX_IMPORT_BYTES ?? 2_000_000_000
  )
  const result: DriveRecordingImportResult = {
    imported: 0,
    skipped: 0,
    matched: 0,
    jobs: [],
    errors: [],
    files: [],
  }

  for (const fileId of selectedFileIds) {
    try {
      const response = await drive.files.get({
        fileId,
        supportsAllDrives: true,
        fields:
          "id,name,mimeType,webViewLink,createdTime,modifiedTime,size,videoMediaMetadata",
      })
      const file = response.data

      if (!file.id || !file.name || !isLikelyMeetRecording(file.name, file.mimeType)) {
        result.skipped += 1
        const error = `${fileId}: not a likely meeting recording`
        result.errors.push(error)
        result.files.push({ fileId, name: file.name ?? undefined, status: "skipped", error })
        continue
      }

      const fileSizeBytes = file.size ? Number(file.size) : 0
      if (fileSizeBytes > maxImportBytes) {
        result.skipped += 1
        const error = `${file.name}: exceeds import size limit`
        result.errors.push(error)
        result.files.push({ fileId: file.id, name: file.name, status: "skipped", error })
        continue
      }

      const match = await findMatchingCalendarEvent({
        identityId,
        scope,
        fileName: file.name,
        fileTime: safeDate(file.createdTime ?? file.modifiedTime),
      })
      const driveFileId = await upsertDriveFileMetadata({
        identityId,
        googleFileId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        webViewLink: file.webViewLink,
        createdTime: file.createdTime,
        modifiedTime: file.modifiedTime,
        size: file.size,
        calendarEventId: match?.id,
        raw: file,
      })
      const lockClient = await pool.connect()

      try {
        await lockClient.query(`select pg_advisory_lock(hashtext($1))`, [
          driveFileId,
        ])

        const existingValues: unknown[] = [driveFileId, workspaceId]
        const existingVisible = meetingScopeSql(scope, "m", existingValues)
        const existing = await lockClient.query(
          `
            select
              df.imported_at,
              mdf.meeting_id,
              j.id as job_id,
              j.status as job_status,
              j.error as job_error
            from drive_files df
            left join meeting_drive_files mdf on mdf.drive_file_id = df.id
              and mdf.meeting_id in (select m.id from meetings m where ${existingVisible})
            left join jobs j on j.meeting_id = mdf.meeting_id
              and j.workspace_id = $2
              and j.name in ('media.ingest', 'meeting.transcribe', 'meeting.summarize', 'meeting.index')
              and j.status in ('completed', 'queued', 'active', 'failed')
            where df.id = $1 and (df.imported_at is not null or j.id is not null)
            order by
              case j.status when 'completed' then 0 when 'active' then 1 when 'queued' then 2 when 'failed' then 3 else 4 end,
              j.created_at desc nulls last
            limit 1
          `,
          existingValues
        )
        const existingRow = existing.rows[0] as
          | {
              imported_at?: string | Date | null
              meeting_id?: string | null
              job_id?: string | null
              job_status?: string | null
              job_error?: string | null
            }
          | undefined

        if (existingRow) {
          result.skipped += 1
          result.files.push({
            fileId: file.id,
            name: file.name,
            status:
              existingRow.job_status === "completed"
                ? "already_imported"
                : existingRow.job_status === "failed"
                ? "failed"
                : existingRow.job_id
                  ? "queued"
                  : "already_imported",
            meetingId: existingRow.meeting_id ?? undefined,
            jobId: existingRow.job_id ?? undefined,
            error: existingRow.job_error ?? undefined,
          })
          continue
        }

        const meeting = await resolveDriveImportMeeting({
          repo,
          visibleRepo,
          settings,
          preferredMeetingId: options.preferredMeetingId,
          matchedMeetingId: match?.meeting_id,
          title: match?.title ?? file.name.replace(/\.[^.]+$/, ""),
          startedAt: file.createdTime ?? new Date().toISOString(),
          ownerUserId: options.ownerUserId,
        })

        if (!meeting) {
          throw new Error(`Target meeting not found for Drive file ${file.id}`)
        }

        if (match?.id) {
          await lockClient.query(
            `update meetings set calendar_event_id = $2
             where id = $1 and workspace_id = $3 and calendar_event_id is null`,
            [meeting.id, match.id, workspaceId]
          )
        }

        const media = await prepareDriveMediaForStorage({
          drive,
          fileId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
          keepVideo: settings.retainVideoByDefault,
        })
        const stored = await storeDriveMedia({
          db: lockClient,
          repo,
          meetingId: meeting.id,
          fileId: file.id,
          media,
        })
        await lockClient.query(`update drive_files set imported_at = now() where id = $1`, [
          driveFileId,
        ])
        await lockClient.query(
          `
            insert into meeting_drive_files (meeting_id, drive_file_id, match_method, confidence)
            values ($1, $2, $3, $4)
            on conflict do nothing
          `,
          [
            meeting.id,
            driveFileId,
            match?.matchMethod ?? "drive_import",
            match?.confidence ?? 0.7,
          ]
        )
        // autoProcessImportedMedia=false: store the recording, process later.
        const job = settings.autoProcessImportedMedia
          ? await enqueueMeetSumJob("media.ingest", {
              meetingId: meeting.id,
              workspaceId,
              storageKey: stored.key,
              bucket: stored.bucket,
              source: "google_drive",
              sourceFileId: file.id,
              stage: "audio.transcribe",
            })
          : undefined

        if (job) result.jobs.push(job)
        result.imported += 1
        if (match) result.matched += 1
        result.files.push({
          fileId: file.id,
          name: file.name,
          status: job ? "queued" : "imported",
          meetingId: meeting.id,
          jobId: job?.id,
        })
      } finally {
        await lockClient
          .query(`select pg_advisory_unlock(hashtext($1))`, [driveFileId])
          .catch(() => undefined)
        lockClient.release()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.skipped += 1
      result.errors.push(message)
      result.files.push({ fileId, status: "failed", error: message })
    }
  }

  return result
}

export async function pollCalendar(target: GoogleWorkspaceTarget): Promise<SyncStats> {
  const { subject, workspaceId } = target

  await setSyncState(target, "calendar", { status: "running" })

  const stats: SyncStats = {
    source: "calendar",
    created: 0,
    updated: 0,
    cancelled: 0,
    errors: [],
  }

  try {
    const auth = await createDelegatedGoogleClient(
      subject,
      GOOGLE_WORKSPACE_SCOPES.calendar
    )
    const calendar = google.calendar({ version: "v3", auth })
    const pool = getDatabasePool()
    const settings = await loadImportSettings(workspaceId)
    const identityId = await getIdentityId(target)
    const calendarList = await calendar.calendarList.list({ maxResults: 250 })
    const previousCursor = parseCursor(await getSyncCursor(target, "calendar"))
    const nextCursor: CalendarCursor = { ...previousCursor }
    const importAll = envBoolean("MEETSUM_CALENDAR_IMPORT_ALL", false)
    const lookbackDays = envInt("MEETSUM_CALENDAR_LOOKBACK_DAYS", 30)
    const lookaheadDays = envInt("MEETSUM_CALENDAR_LOOKAHEAD_DAYS", 60)

    for (const item of calendarList.data.items ?? []) {
      if (!item.id) continue

      if (shouldSkipCalendar(item, importAll)) {
        stats.skipped = (stats.skipped ?? 0) + 1
        continue
      }

      try {
        const syncToken = previousCursor[item.id]
        const events = await calendar.events.list({
          calendarId: item.id,
          singleEvents: syncToken ? undefined : true,
          orderBy: syncToken ? undefined : "startTime",
          timeMin: syncToken
            ? undefined
            : new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString(),
          timeMax: syncToken
            ? undefined
            : new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000).toISOString(),
          maxResults: 2500,
          syncToken,
        })

        if (events.data.nextSyncToken) {
          nextCursor[item.id] = events.data.nextSyncToken
        }

        for (const event of events.data.items ?? []) {
          if (!event.id) continue
          if (!shouldImportCalendarEvent(event, importAll)) {
            stats.skipped = (stats.skipped ?? 0) + 1
            continue
          }

          const proposedCalendarEventId = createHashedId(
            "gcal",
            `${identityId}:${item.id}:${event.id}`
          )
          const title = event.summary ?? "Untitled meeting"
          const startsAt = eventDateTime(event.start)
          const endsAt = eventDateTime(event.end)
          const eventResult = await pool.query(
            `
              insert into calendar_events (
                id, google_identity_id, google_event_id, calendar_id, title,
                starts_at, ends_at, meet_link, status, organizer_email,
                attendees, raw, provider, workspace_id, ical_uid
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
                'google', $13, $14)
              on conflict (google_identity_id, google_event_id)
              do update set
                workspace_id = excluded.workspace_id,
                ical_uid = coalesce(excluded.ical_uid, calendar_events.ical_uid),
                updated_at = now(),
                calendar_id = excluded.calendar_id,
                title = excluded.title,
                starts_at = excluded.starts_at,
                ends_at = excluded.ends_at,
                meet_link = excluded.meet_link,
                status = excluded.status,
                organizer_email = excluded.organizer_email,
                attendees = excluded.attendees,
              raw = excluded.raw
              returning id, (xmax = 0) as inserted
            `,
            [
              proposedCalendarEventId,
              identityId,
              event.id,
              item.id,
              title,
              startsAt ?? null,
              endsAt ?? null,
              extractMeetLink(event),
              event.status ?? null,
              event.organizer?.email ?? null,
              JSON.stringify(event.attendees ?? []),
              JSON.stringify(event),
              workspaceId,
              event.iCalUID ?? null,
            ]
          )
          const calendarEventRow = eventResult.rows[0] as
            | { id?: string; inserted?: boolean }
            | undefined
          const calendarEventId = calendarEventRow?.id ?? proposedCalendarEventId
          const inserted = Boolean(calendarEventRow?.inserted)

          if (inserted) stats.created = (stats.created ?? 0) + 1
          else stats.updated = (stats.updated ?? 0) + 1

          if (event.status === "cancelled") {
            stats.cancelled = (stats.cancelled ?? 0) + 1
            await pool.query(
              `update meetings set status = 'failed'
               where calendar_event_id = $1 and workspace_id = $2 and status <> 'completed'`,
              [calendarEventId, workspaceId]
            )
            if (isBotEnabled()) {
              await cancelCalendarBotSession({
                workspaceId,
                calendarEventId,
                reason: "event_cancelled",
              }).catch((error: unknown) => {
                stats.errors?.push(`bot: ${redactBotError(error)}`)
              })
            }
            continue
          }

          if (startsAt) {
            const existingMeeting = await pool.query(
              `select id from meetings
               where calendar_event_id = $1 and workspace_id = $2 limit 1`,
              [calendarEventId, workspaceId]
            )
            const ownMeetingId = (existingMeeting.rows[0] as { id?: string } | undefined)?.id

            // M8 iCalUID dedupe: the same meeting already synced from another
            // calendar (e.g. Outlook) owns the meeting and the bot session.
            if (
              !ownMeetingId &&
              (await findCanonicalMeetingId(pool, {
                workspaceId,
                icalUid: event.iCalUID,
                startsAt,
                calendarEventId,
              }))
            ) {
              stats.skipped = (stats.skipped ?? 0) + 1
              continue
            }

            const meetingId = ownMeetingId ?? createHashedId("meet_google", calendarEventId)
            const participantRecords = calendarParticipants({
              organizer: event.organizer,
              attendees: event.attendees as CalendarAttendee[] | null | undefined,
            })
            // New meetings belong to the workspace (owner = the subject's user
            // when known, visibility/language from workspace settings); the
            // conflict update never touches another workspace's row.
            const upserted = await pool.query(
              `
                insert into meetings (
                  id, calendar_event_id, title, source, language, status,
                  retention, started_at, participants, google_meet_link,
                  workspace_id, owner_user_id, visibility
                )
                values ($1, $2, $3, 'google_meet', $7, 'scheduled',
                  'audio', $4, $5::jsonb, $6,
                  $8,
                  (select id from users where lower(email) = lower($9) limit 1),
                  $10)
                on conflict (id)
                do update set
                  title = excluded.title,
                  calendar_event_id = excluded.calendar_event_id,
                  started_at = excluded.started_at,
                  participants = excluded.participants,
                  google_meet_link = excluded.google_meet_link
                where meetings.workspace_id = excluded.workspace_id
                returning id
              `,
              [
                meetingId,
                calendarEventId,
                title,
                startsAt,
                JSON.stringify(
                  participantRecords
                    .map((participant) => participant.name || participant.email)
                    .filter(Boolean)
                ),
                extractMeetLink(event),
                importedMeetingLanguage(settings),
                workspaceId,
                subject,
                settings.defaultMeetingVisibility,
              ]
            )

            if (!upserted.rows.length) continue

            await upsertMeetingParticipantsFromCalendar({
              meetingId,
              event: {
                organizer: event.organizer,
                attendees: event.attendees as CalendarAttendee[] | null | undefined,
              },
            })

            if (isBotEnabled()) {
              await syncCalendarBotSession({
                workspaceId,
                subject,
                calendarEventId,
                meetingId,
                event,
              }).catch((error: unknown) => {
                stats.errors?.push(`bot: ${redactBotError(error)}`)
              })
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Calendar page failed"

        stats.errors?.push(`${item.summary ?? item.id}: ${message}`)
        delete nextCursor[item.id]
      }
    }

    try {
      await setSyncState(target, "calendar", {
        status: "completed",
        cursorValue: JSON.stringify(nextCursor),
        stats,
        nextPollAt: new Date(Date.now() + 15 * 60 * 1000),
      })
    } catch (persistError) {
      // Losing the sync cursor forces a full re-sync next run (events dedupe on
      // calendar_event_id, so no duplicate meetings — but log it loudly).
      console.error(
        "[pollCalendar] failed to persist sync cursor; next run will full-resync",
        persistError
      )
      throw persistError
    }
    return stats
  } catch (error) {
    const message = error instanceof Error ? error.message : "Calendar sync failed"

    await setSyncState(target, "calendar", {
      status: "failed",
      lastError: message,
      stats: { ...stats, errors: [...(stats.errors ?? []), message] },
      nextPollAt: new Date(Date.now() + 15 * 60 * 1000),
    })
    throw error
  }
}

export async function pollDrive(target: GoogleWorkspaceTarget): Promise<SyncStats> {
  const { subject, workspaceId } = target

  await setSyncState(target, "drive", { status: "running" })

  const stats: SyncStats = {
    source: "drive",
    discovered: 0,
    matched: 0,
    imported: 0,
    skipped: 0,
    errors: [],
  }

  try {
    const auth = await createDelegatedGoogleClient(subject, GOOGLE_WORKSPACE_SCOPES.drive)
    const drive = google.drive({ version: "v3", auth })
    const pool = getDatabasePool()
    const repo = getSystemMeetingRepository(workspaceId)
    const settings = await loadImportSettings(workspaceId)
    const identityId = await getIdentityId(target)
    const maxImports = Number(process.env.MEETSUM_DRIVE_MAX_IMPORTS_PER_POLL ?? 2)
    const maxImportBytes = Number(
      process.env.MEETSUM_DRIVE_MAX_IMPORT_BYTES ?? 2_000_000_000
    )
    const response = await drive.files.list({
      pageSize: 100,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields:
        "files(id,name,mimeType,webViewLink,createdTime,modifiedTime,size,videoMediaMetadata)",
      q: "trashed = false and (mimeType contains 'video/' or mimeType contains 'audio/')",
      orderBy: "modifiedTime desc",
    })

    for (const file of response.data.files ?? []) {
      if ((stats.imported ?? 0) >= maxImports) {
        stats.skipped = (stats.skipped ?? 0) + 1
        continue
      }

      if (!file.id || !file.name || !isLikelyMeetRecording(file.name, file.mimeType)) {
        stats.skipped = (stats.skipped ?? 0) + 1
        continue
      }

      const fileSizeBytes = file.size ? Number(file.size) : 0
      if (fileSizeBytes > maxImportBytes) {
        stats.skipped = (stats.skipped ?? 0) + 1
        continue
      }

      const fileTime = safeDate(file.createdTime ?? file.modifiedTime)
      const proposedDriveFileId = createHashedId("gdrive", `${identityId}:${file.id}`)
      const match = await findMatchingCalendarEvent({
        identityId,
        scope: { kind: "system", workspaceId },
        fileName: file.name,
        fileTime,
      })

      const driveFileResult = await pool.query(
        `
          insert into drive_files (
            id, google_identity_id, google_file_id, name, mime_type,
            web_view_link, created_time, modified_time, size_bytes,
            calendar_event_id, raw
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
          on conflict (google_identity_id, google_file_id)
          do update set
            name = excluded.name,
            mime_type = excluded.mime_type,
            web_view_link = excluded.web_view_link,
            modified_time = excluded.modified_time,
            size_bytes = excluded.size_bytes,
            calendar_event_id = coalesce(excluded.calendar_event_id, drive_files.calendar_event_id),
            raw = excluded.raw
          returning id
        `,
        [
          proposedDriveFileId,
          identityId,
          file.id,
          file.name,
          file.mimeType ?? null,
          file.webViewLink ?? null,
          file.createdTime ?? null,
          file.modifiedTime ?? null,
          file.size ? Number(file.size) : null,
          match?.id ?? null,
          JSON.stringify(file),
        ]
      )
      const driveFileId =
        (driveFileResult.rows[0] as { id?: string } | undefined)?.id ??
        proposedDriveFileId
      stats.discovered = (stats.discovered ?? 0) + 1

      const existing = await pool.query(
        `select imported_at from drive_files where id = $1 and imported_at is not null`,
        [driveFileId]
      )
      if (existing.rows.length > 0) {
        stats.skipped = (stats.skipped ?? 0) + 1
        continue
      }

      const meeting = await resolveDriveImportMeeting({
        repo,
        visibleRepo: repo,
        settings,
        matchedMeetingId: match?.meeting_id,
        title: match?.title ?? file.name.replace(/\.[^.]+$/, ""),
        startedAt: file.createdTime ?? new Date().toISOString(),
      })

      if (!meeting) {
        throw new Error(`Matched meeting not found for Drive file ${file.id}`)
      }
      if (match?.id) {
        await pool.query(
          `update meetings set calendar_event_id = $2
           where id = $1 and workspace_id = $3 and calendar_event_id is null`,
          [meeting.id, match.id, workspaceId]
        )
      }

      const media = await prepareDriveMediaForStorage({
        drive,
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        keepVideo: settings.retainVideoByDefault,
      })
      const stored = await storeDriveMedia({
        db: pool,
        repo,
        meetingId: meeting.id,
        fileId: file.id,
        media,
      })
      await pool.query(`update drive_files set imported_at = now() where id = $1`, [
        driveFileId,
      ])
      await pool.query(
        `
          insert into meeting_drive_files (meeting_id, drive_file_id, match_method, confidence)
          values ($1, $2, $3, $4)
          on conflict do nothing
        `,
        [
          meeting.id,
          driveFileId,
          match?.matchMethod ?? "drive_import",
          match?.confidence ?? 0.7,
        ]
      )
      if (settings.autoProcessImportedMedia) {
        await enqueueMeetSumJob("media.ingest", {
          meetingId: meeting.id,
          workspaceId,
          storageKey: stored.key,
          bucket: stored.bucket,
          source: "google_drive",
        })
      }
      if (match) stats.matched = (stats.matched ?? 0) + 1
      stats.imported = (stats.imported ?? 0) + 1
    }

    await setSyncState(target, "drive", {
      status: "completed",
      stats,
      nextPollAt: new Date(Date.now() + 30 * 60 * 1000),
    })
    return stats
  } catch (error) {
    const message = error instanceof Error ? error.message : "Drive sync failed"

    await setSyncState(target, "drive", {
      status: "failed",
      lastError: message,
      stats: { ...stats, errors: [...(stats.errors ?? []), message] },
      nextPollAt: new Date(Date.now() + 30 * 60 * 1000),
    })
    throw error
  }
}

export async function pollGmail(target: GoogleWorkspaceTarget): Promise<SyncStats> {
  const { subject } = target

  await setSyncState(target, "gmail", { status: "running" })

  const stats: SyncStats = {
    source: "gmail",
    discovered: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  }

  try {
    const auth = await createDelegatedGoogleClient(
      subject,
      GOOGLE_WORKSPACE_SCOPES.gmail
    )
    const gmail = google.gmail({ version: "v1", auth })
    const pool = getDatabasePool()
    const identityId = await getIdentityId(target)
    const query =
      process.env.MEETSUM_GMAIL_CONTEXT_QUERY ??
      'newer_than:90d (meet OR "meeting notes" OR recording OR transcript OR summary)'
    const response = await gmail.users.threads.list({
      userId: "me",
      q: query,
      maxResults: Number(process.env.MEETSUM_GMAIL_CONTEXT_LIMIT ?? 25),
    })

    for (const threadRef of response.data.threads ?? []) {
      if (!threadRef.id) continue

      try {
        const thread = await gmail.users.threads.get({
          userId: "me",
          id: threadRef.id,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "To", "Cc", "Date"],
        })
        const messages = thread.data.messages ?? []
        const firstMessage = messages[0]
        const headers = firstMessage?.payload?.headers ?? []
        const header = (name: string) =>
          headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value
        const subjectLine = header("Subject") ?? "(no subject)"
        const participants = [header("From"), header("To"), header("Cc")]
          .filter(Boolean)
          .join(", ")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
        const gmailThreadId = thread.data.id ?? threadRef.id
        const id = createHashedId("gmail", `${identityId}:${gmailThreadId}`)

        await pool.query(
          `
            insert into gmail_threads (
              id, google_identity_id, google_thread_id, subject, participants, raw
            )
            values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
            on conflict (google_identity_id, google_thread_id) do update
              set subject = excluded.subject,
                  participants = excluded.participants,
                  raw = excluded.raw
          `,
          [
            id,
            identityId,
            gmailThreadId,
            subjectLine,
            JSON.stringify(participants),
            JSON.stringify(thread.data),
          ]
        )
        stats.discovered = (stats.discovered ?? 0) + 1
        stats.updated = (stats.updated ?? 0) + 1
      } catch (error) {
        stats.errors?.push(error instanceof Error ? error.message : String(error))
      }
    }

    await setSyncState(target, "gmail", {
      status: "completed",
      stats,
      nextPollAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    return stats
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gmail sync failed"

    stats.errors?.push(message)
    await setSyncState(target, "gmail", {
      status: "failed",
      lastError: message,
      stats,
      nextPollAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    return stats
  }
}
