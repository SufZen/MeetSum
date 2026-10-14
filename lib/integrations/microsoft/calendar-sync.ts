/**
 * Outlook calendar delta sync into M7 bot rules (docs/parity/m8.md, B2).
 *
 * One run = one personal Microsoft connection (its user's own calendar
 * only), scoped to the connection's workspace. Flow:
 *   1. `GET /me/calendarView/delta` over `now − 1 d … now + lookahead`
 *      (full) or the stored `@odata.deltaLink` (incremental); follow
 *      `@odata.nextLink`; a 410 `syncStateNotFound` restarts a full sync.
 *   2. Per event: upsert the `calendar_events` row (`provider='microsoft'`),
 *      then the canonical-meeting check (iCalUID dedupe), then create or
 *      update the meeting and call M7 `syncCalendarBotSession` for
 *      canonical rows only. `@removed`/cancelled → cancel.
 *   3. Persist `deltaLink`, the window and `lastSync` (counts only).
 *
 * Graph delta details to VERIFY against current docs before the first live
 * run: calendarView/delta accepts only start/end on the initial request (the
 * delta/next links carry them afterwards), `Prefer: odata.maxpagesize` is
 * honoured, `outlook.timezone` applies to delta responses, deleted
 * occurrences come back as `@removed` with only an id, and an expired delta
 * token answers 410 with `syncStateNotFound` (or `resyncRequired`).
 */
import { createHash } from "node:crypto"

import type { CalendarEventLike } from "@/lib/bot/types"
import type { ProviderFetch } from "@/lib/integrations/core/types"
import {
  type LockableQueryable,
  findCanonicalMeetingId,
  ownMeetingId,
  withCalendarDedupeLock,
} from "@/lib/integrations/microsoft/calendar-dedupe"
import { type GraphEvent, type MappedOutlookEvent, mapGraphEventToCalendarEventLike } from "@/lib/integrations/microsoft/calendar-map"
import { ProviderError } from "@/lib/integrations/core/types"
import { GRAPH_BASE, graphGet, isSyncStateLost } from "@/lib/integrations/microsoft/graph"

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_PAGES = 200

export const OUTLOOK_PREFER_HEADER = 'odata.maxpagesize=100, outlook.timezone="UTC", outlook.body-content-type="text"'

/** Non-secret sync cursor kept in `integration_connections.config.calendarSync`. */
export type OutlookSyncCursor = {
  deltaLink?: string
  windowStart?: string
  windowEnd?: string
  fullSyncAt?: string
}

export type OutlookSyncStats = {
  at: string
  full: boolean
  events: number
  meetings: number
  cancelled: number
  skipped: number
  deduped: number
  errors: number
  /** Rows skipped because the dedupe lock, lookup or insert failed (fail closed). */
  dedupeFailures?: number
}

export type OutlookBotSync = (input: {
  workspaceId: string
  subject: string
  calendarEventId: string
  meetingId: string
  event: CalendarEventLike
}) => Promise<unknown>

export type OutlookBotCancel = (input: {
  workspaceId: string
  calendarEventId: string
  reason: "event_cancelled"
}) => Promise<unknown>

export type OutlookSyncDeps = {
  db: LockableQueryable
  fetch: ProviderFetch
  getAccessToken(): Promise<string>
  workspaceId: string
  connectionId: string
  /** The connection's user: meeting owner and the M7 `subject`. */
  userId: string
  userEmail: string
  cursor: OutlookSyncCursor
  /** Persists `{calendarSync, lastSync}` into the connection config. */
  saveConfig(patch: { calendarSync: OutlookSyncCursor; lastSync: Omit<OutlookSyncStats, "full"> }): Promise<void>
  settings: { defaultMeetingVisibility: "workspace" | "private"; language: string }
  botEnabled: boolean
  botAccountEmail?: string
  syncBot: OutlookBotSync
  cancelBot: OutlookBotCancel
  lookaheadDays?: number
  now?: () => Date
}

function hashedId(prefix: string, stable: string): string {
  return `${prefix}_${createHash("sha256").update(stable).digest("hex").slice(0, 32)}`
}

export function outlookCalendarEventId(connectionId: string, externalEventId: string): string {
  return hashedId("mscal", `${connectionId}:${externalEventId}`)
}

export function outlookMeetingId(calendarEventId: string): string {
  return hashedId("meet_outlook", calendarEventId)
}

function syncWindow(now: Date, lookaheadDays: number) {
  return {
    start: new Date(now.getTime() - DAY_MS).toISOString(),
    end: new Date(now.getTime() + lookaheadDays * DAY_MS).toISOString(),
  }
}

/** Full resync: no delta link, daily, or when the window moved more than a day. */
export function needsFullSync(cursor: OutlookSyncCursor, now: Date, lookaheadDays: number): boolean {
  if (!cursor.deltaLink || !cursor.windowStart || !cursor.fullSyncAt) return true

  const fullAt = Date.parse(cursor.fullSyncAt)
  const storedStart = Date.parse(cursor.windowStart)
  const wanted = Date.parse(syncWindow(now, lookaheadDays).start)

  if (!Number.isFinite(fullAt) || now.getTime() - fullAt >= DAY_MS) return true
  return !Number.isFinite(storedStart) || wanted - storedStart > DAY_MS
}

function fullSyncUrl(window: { start: string; end: string }): string {
  const url = new URL(`${GRAPH_BASE}/me/calendarView/delta`)

  url.searchParams.set("startDateTime", window.start)
  url.searchParams.set("endDateTime", window.end)
  return url.toString()
}

type DeltaPage = { value?: GraphEvent[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }

async function readDelta(deps: OutlookSyncDeps, startUrl: string, token: string) {
  const events: GraphEvent[] = []
  let url: string | undefined = startUrl
  let deltaLink: string | undefined

  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const body: DeltaPage = await graphGet<DeltaPage>(deps.fetch, token, url, { prefer: OUTLOOK_PREFER_HEADER })

    events.push(...(body.value ?? []))
    deltaLink = body["@odata.deltaLink"] ?? deltaLink
    url = body["@odata.nextLink"]
  }

  return { events, deltaLink }
}

function isOtherPerson(email: string | null | undefined, deps: OutlookSyncDeps): boolean {
  const value = email?.trim().toLowerCase()

  return Boolean(value && value !== deps.userEmail.toLowerCase() && value !== deps.botAccountEmail)
}

/** Mirrors Google's `shouldImportCalendarEvent`: a supported link or another attendee. */
function shouldCreateMeeting(mapped: MappedOutlookEvent, deps: OutlookSyncDeps): boolean {
  if (mapped.meetLink) return true
  if (isOtherPerson(mapped.organizerEmail, deps)) return true
  return (mapped.event.attendees ?? []).some((attendee) => !attendee.resource && isOtherPerson(attendee.email, deps))
}

/** The row id, or undefined when the conflict row is not this workspace's (never adopted). */
async function upsertCalendarRow(deps: OutlookSyncDeps, mapped: MappedOutlookEvent): Promise<string | undefined> {
  const id = outlookCalendarEventId(deps.connectionId, mapped.externalEventId)
  const result = await deps.db.query(
    `insert into calendar_events (
        id, provider, workspace_id, integration_connection_id, external_event_id, ical_uid,
        title, starts_at, ends_at, meet_link, status, organizer_email, attendees, raw, updated_at
      )
      values ($1, 'microsoft', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, now())
      on conflict (integration_connection_id, external_event_id) where provider = 'microsoft'
      do update set
        ical_uid = excluded.ical_uid,
        title = excluded.title,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        meet_link = excluded.meet_link,
        status = excluded.status,
        organizer_email = excluded.organizer_email,
        attendees = excluded.attendees,
        raw = excluded.raw,
        updated_at = now()
      where calendar_events.workspace_id = excluded.workspace_id
      returning id`,
    [
      id,
      deps.workspaceId,
      deps.connectionId,
      mapped.externalEventId,
      mapped.iCalUID ?? null,
      mapped.title,
      mapped.startsAt,
      mapped.endsAt ?? null,
      mapped.meetLink,
      mapped.status,
      mapped.organizerEmail ?? null,
      JSON.stringify(mapped.event.attendees ?? []),
      JSON.stringify({ ...mapped.event, iCalUID: mapped.iCalUID ?? null }),
    ]
  )

  return (result.rows[0] as { id?: string } | undefined)?.id
}

function participantsOf(mapped: MappedOutlookEvent, deps: OutlookSyncDeps) {
  const byEmail = new Map<string, { name: string; email: string; role: "organizer" | "attendee"; status: string }>()
  const organizer = mapped.event.organizer

  if (organizer?.email && organizer.email !== deps.botAccountEmail) {
    byEmail.set(organizer.email, {
      name: organizer.displayName?.trim() || organizer.email.split("@")[0] || organizer.email,
      email: organizer.email,
      role: "organizer",
      status: "unknown",
    })
  }

  for (const attendee of mapped.event.attendees ?? []) {
    if (!attendee.email || attendee.resource || attendee.email === deps.botAccountEmail) continue
    byEmail.set(attendee.email, {
      name: attendee.displayName?.trim() || attendee.email.split("@")[0] || attendee.email,
      email: attendee.email,
      role: attendee.organizer ? "organizer" : "attendee",
      status:
        attendee.responseStatus === "needsAction" ? "needs_action" : (attendee.responseStatus ?? "unknown"),
    })
  }

  return [...byEmail.values()]
}

async function upsertMeeting(deps: OutlookSyncDeps, mapped: MappedOutlookEvent, calendarEventId: string, meetingId: string) {
  const participants = participantsOf(mapped, deps)
  const result = await deps.db.query(
    `insert into meetings (
        id, calendar_event_id, title, source, language, status, retention, started_at,
        participants, workspace_id, owner_user_id, visibility
      )
      values ($1, $2, $3, 'outlook_calendar', $4, 'scheduled', 'audio', $5, $6::jsonb, $7, $8, $9)
      on conflict (id) do update set
        title = excluded.title,
        calendar_event_id = excluded.calendar_event_id,
        started_at = excluded.started_at,
        participants = excluded.participants
      where meetings.workspace_id = excluded.workspace_id
      returning id`,
    [
      meetingId,
      calendarEventId,
      mapped.title,
      deps.settings.language,
      mapped.startsAt,
      JSON.stringify(participants.map((participant) => participant.name)),
      deps.workspaceId,
      deps.userId,
      mapped.isPrivate ? "private" : deps.settings.defaultMeetingVisibility,
    ]
  )

  if (!result.rows.length) return false

  for (const participant of participants) {
    await deps.db.query(
      `insert into meeting_participants (id, meeting_id, name, email, role, source, attendance_status, confidence)
       values ($1, $2, $3, $4, $5, 'calendar', $6, 0.9)
       on conflict (id) do update set
         name = excluded.name, email = excluded.email, role = excluded.role,
         attendance_status = excluded.attendance_status, updated_at = now()`,
      [
        hashedId("participant", `${meetingId}:${participant.email}`),
        meetingId,
        participant.name,
        participant.email,
        participant.role,
        participant.status,
      ]
    )
  }

  return true
}

async function cancelRow(deps: OutlookSyncDeps, calendarEventId: string) {
  await deps.db.query(
    `update meetings set status = 'failed'
      where calendar_event_id = $1 and workspace_id = $2 and status = 'scheduled'`,
    [calendarEventId, deps.workspaceId]
  )
  if (deps.botEnabled) {
    await deps.cancelBot({ workspaceId: deps.workspaceId, calendarEventId, reason: "event_cancelled" })
  }
}

async function applyRemoval(deps: OutlookSyncDeps, externalEventId: string, stats: OutlookSyncStats) {
  const result = await deps.db.query(
    `update calendar_events set status = 'cancelled', updated_at = now()
      where provider = 'microsoft' and integration_connection_id = $1 and external_event_id = $2
        and workspace_id = $3
      returning id`,
    [deps.connectionId, externalEventId, deps.workspaceId]
  )
  const id = (result.rows[0] as { id?: string } | undefined)?.id

  if (!id) return
  stats.cancelled += 1
  await cancelRow(deps, id)
}

/**
 * `@removed` (reason `deleted`) also covers events moved or changed *outside*
 * the calendarView window, so it is not proof of a cancellation (verified
 * 2026-10-14, https://learn.microsoft.com/en-us/graph/api/event-delta). Look
 * the event up: cancel only when it is gone (404/410) or `isCancelled`.
 */
async function eventStillScheduled(deps: OutlookSyncDeps, token: string, eventId: string): Promise<boolean> {
  try {
    const event = await graphGet<{ isCancelled?: boolean | null }>(
      deps.fetch,
      token,
      `${GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}?$select=id,isCancelled`
    )

    return !event.isCancelled
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "not_found") return false
    throw error
  }
}

async function applyEvent(deps: OutlookSyncDeps, graph: GraphEvent, stats: OutlookSyncStats, token: string) {
  if (graph["@removed"]) {
    if (await eventStillScheduled(deps, token, graph.id)) {
      stats.skipped += 1
      return
    }
    await applyRemoval(deps, graph.id, stats)
    return
  }

  const mapped = mapGraphEventToCalendarEventLike(graph, { selfEmail: deps.userEmail })

  if (!mapped) {
    stats.skipped += 1
    return
  }

  stats.events += 1

  const calendarEventId = await upsertCalendarRow(deps, mapped)

  if (!calendarEventId) {
    stats.errors += 1
    return
  }

  if (mapped.status === "cancelled") {
    stats.cancelled += 1
    await cancelRow(deps, calendarEventId)
    return
  }

  let meetingId: string | undefined

  try {
    // Canonical check + meeting insert: one transaction under the dedupe lock.
    meetingId = await withCalendarDedupeLock(
      deps.db,
      { workspaceId: deps.workspaceId, icalUid: mapped.iCalUID, startsAt: mapped.startsAt },
      async (db): Promise<string | undefined> => {
        let id = await ownMeetingId(db, deps.workspaceId, calendarEventId)

        if (!id) {
          const canonical = await findCanonicalMeetingId(db, {
            workspaceId: deps.workspaceId,
            icalUid: mapped.iCalUID,
            startsAt: mapped.startsAt,
            calendarEventId,
            organizerEmail: mapped.organizerEmail,
            event: mapped.event,
            owner: { userId: deps.userId, email: deps.userEmail },
          })

          if (canonical) {
            // Non-canonical: another calendar already owns this meeting and its bot session.
            stats.deduped += 1
            return undefined
          }
          if (!shouldCreateMeeting(mapped, deps)) {
            stats.skipped += 1
            return undefined
          }
          id = outlookMeetingId(calendarEventId)
        }

        return (await upsertMeeting({ ...deps, db }, mapped, calendarEventId, id)) ? id : undefined
      }
    )
  } catch {
    // Fail closed: no meeting (and no bot) when the lock, lookup or insert fails.
    stats.errors += 1
    stats.dedupeFailures = (stats.dedupeFailures ?? 0) + 1
    return
  }

  if (!meetingId) return
  stats.meetings += 1

  if (deps.botEnabled) {
    await deps.syncBot({
      workspaceId: deps.workspaceId,
      subject: deps.userEmail,
      calendarEventId,
      meetingId,
      event: mapped.event,
    })
  }
}

export async function runOutlookCalendarSync(deps: OutlookSyncDeps): Promise<OutlookSyncStats> {
  const now = (deps.now ?? (() => new Date()))()
  const lookaheadDays = deps.lookaheadDays ?? 14
  const token = await deps.getAccessToken()
  let full = needsFullSync(deps.cursor, now, lookaheadDays)
  const window = full
    ? syncWindow(now, lookaheadDays)
    : { start: deps.cursor.windowStart as string, end: deps.cursor.windowEnd ?? syncWindow(now, lookaheadDays).end }
  let delta: { events: GraphEvent[]; deltaLink?: string }

  try {
    delta = await readDelta(deps, full ? fullSyncUrl(window) : (deps.cursor.deltaLink as string), token)
  } catch (error) {
    if (full || !isSyncStateLost(error)) throw error
    // 410 syncStateNotFound: the delta token expired → full resync.
    full = true
    Object.assign(window, syncWindow(now, lookaheadDays))
    delta = await readDelta(deps, fullSyncUrl(window), token)
  }

  const stats: OutlookSyncStats = {
    at: now.toISOString(),
    full,
    events: 0,
    meetings: 0,
    cancelled: 0,
    skipped: 0,
    deduped: 0,
    errors: 0,
  }

  for (const graph of delta.events) {
    try {
      await applyEvent(deps, graph, stats, token)
    } catch {
      // Counts only: provider/DB messages may hold titles or emails.
      stats.errors += 1
    }
  }

  const cursor: OutlookSyncCursor = {
    deltaLink: delta.deltaLink ?? deps.cursor.deltaLink,
    windowStart: window.start,
    windowEnd: window.end,
    fullSyncAt: full ? now.toISOString() : deps.cursor.fullSyncAt,
  }
  const { full: _full, ...lastSync } = stats

  void _full
  await deps.saveConfig({ calendarSync: cursor, lastSync })
  return stats
}
