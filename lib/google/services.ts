import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"

import { google } from "googleapis"

import { getDatabasePool } from "@/lib/db/client"
import { createDelegatedGoogleClient } from "@/lib/google/auth"
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/google/workspace"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { meetingRepository } from "@/lib/meetings/store"
import { storeMeetingObject } from "@/lib/storage/object-storage"

const execFileAsync = promisify(execFile)

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
  imported: boolean
  importedMeetingId?: string
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

export type DriveRecordingImportResult = {
  imported: number
  skipped: number
  matched: number
  jobs: Awaited<ReturnType<typeof enqueueMeetSumJob>>[]
  errors: string[]
}

function createId(prefix: string, stable: string) {
  return `${prefix}_${Buffer.from(stable).toString("base64url").slice(0, 40)}`
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

  const hasMeetingSignal =
    Boolean(extractMeetLink(event)) || Boolean(event.attendees?.length)

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

async function prepareDriveMediaForStorage(options: {
  drive: ReturnType<typeof google.drive>
  fileId: string
  fileName: string
  mimeType?: string | null
}) {
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

async function getSyncCursor(subject: string, source: GoogleSource) {
  const pool = getDatabasePool()
  const identityId = await getIdentityId(subject)
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
  subject: string,
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
  const identityId = await getIdentityId(subject)
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

async function findMatchingCalendarEvent(options: {
  identityId: string
  fileName: string
  fileTime?: Date
}) {
  if (!options.fileTime) return undefined

  const pool = getDatabasePool()
  const result = await pool.query(
    `
      select ce.id, ce.title, ce.starts_at, m.id as meeting_id
      from calendar_events ce
      left join meetings m on m.calendar_event_id = ce.id
      where ce.google_identity_id = $1
        and ce.starts_at between ($2::timestamptz - interval '12 hours')
                            and ($2::timestamptz + interval '12 hours')
        and coalesce(ce.status, '') <> 'cancelled'
      order by abs(extract(epoch from (ce.starts_at - $2::timestamptz))) asc
      limit 20
    `,
    [options.identityId, options.fileTime.toISOString()]
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
  googleFileId: string
}) {
  const pool = getDatabasePool()
  const result = await pool.query(
    `
      select df.imported_at, mdf.meeting_id
      from drive_files df
      left join meeting_drive_files mdf on mdf.drive_file_id = df.id
      where df.google_identity_id = $1 and df.google_file_id = $2
      limit 1
    `,
    [options.identityId, options.googleFileId]
  )
  const row = result.rows[0] as
    | { imported_at?: string | Date | null; meeting_id?: string | null }
    | undefined

  return {
    imported: Boolean(row?.imported_at),
    importedMeetingId: row?.meeting_id ?? undefined,
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
  subject: string,
  options: {
    limit?: number
    cursor?: string
    query?: string
    includeImported?: boolean
  } = {}
): Promise<DriveRecordingListResult> {
  const auth = await createDelegatedGoogleClient(subject, GOOGLE_WORKSPACE_SCOPES.drive)
  const drive = google.drive({ version: "v3", auth })
  const identityId = await getIdentityId(subject)
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
        googleFileId: file.id,
      })

      if (importStatus.imported && options.includeImported !== true) {
        continue
      }

      const match = await findMatchingCalendarEvent({
        identityId,
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
        imported: importStatus.imported,
        importedMeetingId: importStatus.importedMeetingId,
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
  subject: string,
  fileIds: string[]
): Promise<DriveRecordingImportResult> {
  const selectedFileIds = validateDriveImportFileIds(fileIds)
  const auth = await createDelegatedGoogleClient(subject, GOOGLE_WORKSPACE_SCOPES.drive)
  const drive = google.drive({ version: "v3", auth })
  const pool = getDatabasePool()
  const identityId = await getIdentityId(subject)
  const maxImportBytes = Number(
    process.env.MEETSUM_DRIVE_MAX_IMPORT_BYTES ?? 2_000_000_000
  )
  const result: DriveRecordingImportResult = {
    imported: 0,
    skipped: 0,
    matched: 0,
    jobs: [],
    errors: [],
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
        result.errors.push(`${fileId}: not a likely meeting recording`)
        continue
      }

      const fileSizeBytes = file.size ? Number(file.size) : 0
      if (fileSizeBytes > maxImportBytes) {
        result.skipped += 1
        result.errors.push(`${file.name}: exceeds import size limit`)
        continue
      }

      const match = await findMatchingCalendarEvent({
        identityId,
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
      const existing = await pool.query(
        `select imported_at from drive_files where id = $1 and imported_at is not null`,
        [driveFileId]
      )

      if (existing.rows.length > 0) {
        result.skipped += 1
        continue
      }

      const meeting =
        match?.meeting_id
          ? await meetingRepository.getMeeting(match.meeting_id)
          : await meetingRepository.createMeeting({
              title: match?.title ?? file.name.replace(/\.[^.]+$/, ""),
              source: "google_meet",
              language: "mixed",
              startedAt: file.createdTime ?? new Date().toISOString(),
              participants: [],
            })

      if (!meeting) {
        throw new Error(`Matched meeting not found for Drive file ${file.id}`)
      }

      if (match?.id) {
        await pool.query(
          `update meetings set calendar_event_id = $2 where id = $1 and calendar_event_id is null`,
          [meeting.id, match.id]
        )
      }

      const media = await prepareDriveMediaForStorage({
        drive,
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
      })
      const stored = await storeMeetingObject({
        meetingId: meeting.id,
        filename: media.filename,
        contentType: media.contentType,
        bytes: media.bytes,
      })
      const checksum = createHash("sha256").update(media.bytes).digest("hex")

      await meetingRepository.createMediaAsset({
        meetingId: meeting.id,
        storageKey: stored.key,
        filename: media.filename,
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
        retention: media.retention,
      })
      await pool.query(
        `
          update media_assets
          set source = 'google_drive',
              source_file_id = $2,
              checksum_sha256 = $4
          where meeting_id = $1 and storage_key = $3
        `,
        [meeting.id, file.id, stored.key, checksum]
      )
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
      const job = await enqueueMeetSumJob("media.ingest", {
        meetingId: meeting.id,
        storageKey: stored.key,
        bucket: stored.bucket,
        source: "google_drive",
      })

      result.jobs.push(job)
      result.imported += 1
      if (match) result.matched += 1
    } catch (error) {
      result.skipped += 1
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  return result
}

export async function pollCalendar(subject: string): Promise<SyncStats> {
  await setSyncState(subject, "calendar", { status: "running" })

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
    const identityId = await getIdentityId(subject)
    const calendarList = await calendar.calendarList.list({ maxResults: 250 })
    const previousCursor = parseCursor(await getSyncCursor(subject, "calendar"))
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
                attendees, raw
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
              on conflict (google_identity_id, google_event_id)
              do update set
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
              `update meetings set status = 'failed' where calendar_event_id = $1 and status <> 'completed'`,
              [calendarEventId]
            )
            continue
          }

          if (startsAt) {
            const existingMeeting = await pool.query(
              `select id from meetings where calendar_event_id = $1 limit 1`,
              [calendarEventId]
            )
            const meetingId =
              (existingMeeting.rows[0] as { id?: string } | undefined)?.id ??
              createHashedId("meet_google", calendarEventId)
            await pool.query(
              `
                insert into meetings (
                  id, calendar_event_id, title, source, language, status,
                  retention, started_at, participants, google_meet_link
                )
                values ($1, $2, $3, 'google_meet', 'mixed', 'scheduled',
                  'audio', $4, $5::jsonb, $6)
                on conflict (id)
                do update set
                  title = excluded.title,
                  calendar_event_id = excluded.calendar_event_id,
                  started_at = excluded.started_at,
                  participants = excluded.participants,
                  google_meet_link = excluded.google_meet_link
              `,
              [
                meetingId,
                calendarEventId,
                title,
                startsAt,
                JSON.stringify(
                  (event.attendees ?? [])
                    .map((attendee) => attendee.displayName ?? attendee.email)
                    .filter(Boolean)
                ),
                extractMeetLink(event),
              ]
            )
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Calendar page failed"

        stats.errors?.push(`${item.summary ?? item.id}: ${message}`)
        delete nextCursor[item.id]
      }
    }

    await setSyncState(subject, "calendar", {
      status: "completed",
      cursorValue: JSON.stringify(nextCursor),
      stats,
      nextPollAt: new Date(Date.now() + 15 * 60 * 1000),
    })
    return stats
  } catch (error) {
    const message = error instanceof Error ? error.message : "Calendar sync failed"

    await setSyncState(subject, "calendar", {
      status: "failed",
      lastError: message,
      stats: { ...stats, errors: [...(stats.errors ?? []), message] },
      nextPollAt: new Date(Date.now() + 15 * 60 * 1000),
    })
    throw error
  }
}

export async function pollDrive(subject: string): Promise<SyncStats> {
  await setSyncState(subject, "drive", { status: "running" })

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
    const identityId = await getIdentityId(subject)
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

      const meeting =
        match?.meeting_id
          ? await meetingRepository.getMeeting(match.meeting_id)
          : await meetingRepository.createMeeting({
              title: match?.title ?? file.name.replace(/\.[^.]+$/, ""),
              source: "google_meet",
              language: "mixed",
              startedAt: file.createdTime ?? new Date().toISOString(),
              participants: [],
            })

      if (!meeting) {
        throw new Error(`Matched meeting not found for Drive file ${file.id}`)
      }
      if (match?.id) {
        await pool.query(
          `update meetings set calendar_event_id = $2 where id = $1 and calendar_event_id is null`,
          [meeting.id, match.id]
        )
      }

      const media = await prepareDriveMediaForStorage({
        drive,
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
      })
      const stored = await storeMeetingObject({
        meetingId: meeting.id,
        filename: media.filename,
        contentType: media.contentType,
        bytes: media.bytes,
      })
      const checksum = createHash("sha256").update(media.bytes).digest("hex")

      await meetingRepository.createMediaAsset({
        meetingId: meeting.id,
        storageKey: stored.key,
        filename: media.filename,
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
        retention: media.retention,
      })
      await pool.query(
        `
          update media_assets
          set source = 'google_drive',
              source_file_id = $2,
              checksum_sha256 = $4
          where meeting_id = $1 and storage_key = $3
        `,
        [meeting.id, file.id, stored.key, checksum]
      )
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
      await enqueueMeetSumJob("media.ingest", {
        meetingId: meeting.id,
        storageKey: stored.key,
        bucket: stored.bucket,
        source: "google_drive",
      })
      if (match) stats.matched = (stats.matched ?? 0) + 1
      stats.imported = (stats.imported ?? 0) + 1
    }

    await setSyncState(subject, "drive", {
      status: "completed",
      stats,
      nextPollAt: new Date(Date.now() + 30 * 60 * 1000),
    })
    return stats
  } catch (error) {
    const message = error instanceof Error ? error.message : "Drive sync failed"

    await setSyncState(subject, "drive", {
      status: "failed",
      lastError: message,
      stats: { ...stats, errors: [...(stats.errors ?? []), message] },
      nextPollAt: new Date(Date.now() + 30 * 60 * 1000),
    })
    throw error
  }
}

export async function pollGmail(subject: string): Promise<SyncStats> {
  const stats: SyncStats = { source: "gmail", status: "deferred" }

  await setSyncState(subject, "gmail", {
    status: "completed",
    stats,
    nextPollAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return stats
}
