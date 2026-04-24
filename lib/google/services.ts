import { readFileSync } from "node:fs"

import { google } from "googleapis"

import { getDatabasePool } from "@/lib/db/client"
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/google/workspace"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { meetingRepository } from "@/lib/meetings/store"
import { storeMeetingObject } from "@/lib/storage/object-storage"

type GoogleSource = "calendar" | "drive" | "gmail"

function createId(prefix: string, stable: string) {
  return `${prefix}_${Buffer.from(stable).toString("base64url").slice(0, 40)}`
}

function getPrivateKey() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n")
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    const parsed = JSON.parse(
      readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, "utf8")
    ) as { private_key?: string; client_email?: string }

    return parsed.private_key
  }

  return undefined
}

function getServiceAccountEmail() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    return process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    const parsed = JSON.parse(
      readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, "utf8")
    ) as { client_email?: string }

    return parsed.client_email
  }

  return process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT
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

async function setSyncState(
  subject: string,
  source: GoogleSource,
  patch: {
    status: "idle" | "running" | "completed" | "failed"
    cursorValue?: string
    lastError?: string | null
  }
) {
  const pool = getDatabasePool()
  const identityId = await getIdentityId(subject)
  const id = createId("sync", `${identityId}:${source}`)

  await pool.query(
    `
      insert into google_sync_states (
        id, google_identity_id, source, cursor_value, status, last_error,
        last_synced_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6,
        case when $5 = 'completed' then now() else null end,
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
        updated_at = now()
    `,
    [
      id,
      identityId,
      source,
      patch.cursorValue ?? null,
      patch.status,
      patch.lastError ?? null,
    ]
  )
}

function createDelegatedClient(subject: string, scopes: readonly string[]) {
  const email = getServiceAccountEmail()
  const key = getPrivateKey()

  if (!email || !key) {
    throw new Error(
      "Google Workspace service-account email or private key is missing"
    )
  }

  return new google.auth.JWT({
    email,
    key,
    scopes: [...scopes],
    subject,
  })
}

function eventDateTime(value?: { date?: string | null; dateTime?: string | null }) {
  return value?.dateTime ?? value?.date ?? undefined
}

export async function pollCalendar(subject: string) {
  await setSyncState(subject, "calendar", { status: "running" })

  try {
    const auth = createDelegatedClient(subject, GOOGLE_WORKSPACE_SCOPES.calendar)
    const calendar = google.calendar({ version: "v3", auth })
    const pool = getDatabasePool()
    const identityId = await getIdentityId(subject)
    const calendarList = await calendar.calendarList.list({ maxResults: 250 })
    let upserted = 0

    for (const item of calendarList.data.items ?? []) {
      if (!item.id) continue

      const events = await calendar.events.list({
        calendarId: item.id,
        singleEvents: true,
        orderBy: "startTime",
        timeMin: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        timeMax: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        maxResults: 2500,
      })

      for (const event of events.data.items ?? []) {
        if (!event.id) continue

        const calendarEventId = createId("gcal", `${item.id}:${event.id}`)
        const title = event.summary ?? "Untitled meeting"
        const startsAt = eventDateTime(event.start)
        const endsAt = eventDateTime(event.end)

        await pool.query(
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
          `,
          [
            calendarEventId,
            identityId,
            event.id,
            item.id,
            title,
            startsAt ?? null,
            endsAt ?? null,
            event.hangoutLink ?? event.conferenceData?.entryPoints?.[0]?.uri ?? null,
            event.status ?? null,
            event.organizer?.email ?? null,
            JSON.stringify(event.attendees ?? []),
            JSON.stringify(event),
          ]
        )

        if (event.status !== "cancelled" && startsAt) {
          const meetingId = createId("meet_google", `${item.id}:${event.id}`)
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
              event.hangoutLink ?? null,
            ]
          )
        }

        upserted += 1
      }
    }

    await setSyncState(subject, "calendar", { status: "completed" })
    return { source: "calendar", upserted }
  } catch (error) {
    await setSyncState(subject, "calendar", {
      status: "failed",
      lastError: error instanceof Error ? error.message : "Calendar sync failed",
    })
    throw error
  }
}

function isLikelyMeetRecording(name: string, mimeType?: string | null) {
  const normalized = name.toLowerCase()
  return (
    /meet|recording|פגישה|הקלט/.test(normalized) &&
    (mimeType?.startsWith("video/") || mimeType?.startsWith("audio/"))
  )
}

export async function pollDrive(subject: string) {
  await setSyncState(subject, "drive", { status: "running" })

  try {
    const auth = createDelegatedClient(subject, GOOGLE_WORKSPACE_SCOPES.drive)
    const drive = google.drive({ version: "v3", auth })
    const pool = getDatabasePool()
    const identityId = await getIdentityId(subject)
    const response = await drive.files.list({
      pageSize: 100,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields:
        "files(id,name,mimeType,webViewLink,createdTime,modifiedTime,size)",
      q: "trashed = false and (mimeType contains 'video/' or mimeType contains 'audio/')",
    })
    let discovered = 0
    let imported = 0

    for (const file of response.data.files ?? []) {
      if (!file.id || !file.name || !isLikelyMeetRecording(file.name, file.mimeType)) {
        continue
      }

      const driveFileId = createId("gdrive", file.id)
      await pool.query(
        `
          insert into drive_files (
            id, google_identity_id, google_file_id, name, mime_type,
            web_view_link, created_time, modified_time, size_bytes, raw
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          on conflict (google_identity_id, google_file_id)
          do update set
            name = excluded.name,
            mime_type = excluded.mime_type,
            web_view_link = excluded.web_view_link,
            modified_time = excluded.modified_time,
            size_bytes = excluded.size_bytes,
            raw = excluded.raw
        `,
        [
          driveFileId,
          identityId,
          file.id,
          file.name,
          file.mimeType ?? null,
          file.webViewLink ?? null,
          file.createdTime ?? null,
          file.modifiedTime ?? null,
          file.size ? Number(file.size) : null,
          JSON.stringify(file),
        ]
      )
      discovered += 1

      const existing = await pool.query(
        `select imported_at from drive_files where id = $1 and imported_at is not null`,
        [driveFileId]
      )
      if (existing.rows.length > 0) continue

      const media = await drive.files.get(
        { fileId: file.id, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" }
      )
      const bytes = Buffer.from(media.data as ArrayBuffer)
      const meeting = await meetingRepository.createMeeting({
        title: file.name.replace(/\.[^.]+$/, ""),
        source: "google_meet",
        language: "mixed",
        startedAt: file.createdTime ?? new Date().toISOString(),
        participants: [],
      })
      const stored = await storeMeetingObject({
        meetingId: meeting.id,
        filename: file.name,
        contentType: file.mimeType ?? "application/octet-stream",
        bytes,
      })

      await meetingRepository.createMediaAsset({
        meetingId: meeting.id,
        storageKey: stored.key,
        filename: file.name,
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
        retention: stored.contentType.startsWith("video/") ? "video" : "audio",
      })
      await pool.query(
        `update media_assets set source = 'google_drive', source_file_id = $2 where meeting_id = $1 and storage_key = $3`,
        [meeting.id, file.id, stored.key]
      )
      await pool.query(`update drive_files set imported_at = now() where id = $1`, [
        driveFileId,
      ])
      await pool.query(
        `
          insert into meeting_drive_files (meeting_id, drive_file_id, match_method, confidence)
          values ($1, $2, 'drive_import', 0.7)
          on conflict do nothing
        `,
        [meeting.id, driveFileId]
      )
      await enqueueMeetSumJob("media.ingest", {
        meetingId: meeting.id,
        storageKey: stored.key,
        bucket: stored.bucket,
        source: "google_drive",
      })
      imported += 1
    }

    await setSyncState(subject, "drive", { status: "completed" })
    return { source: "drive", discovered, imported }
  } catch (error) {
    await setSyncState(subject, "drive", {
      status: "failed",
      lastError: error instanceof Error ? error.message : "Drive sync failed",
    })
    throw error
  }
}

export async function pollGmail(subject: string) {
  await setSyncState(subject, "gmail", { status: "running" })
  await setSyncState(subject, "gmail", { status: "completed" })
  return { source: "gmail", status: "deferred" }
}
