/**
 * Cross-provider canonical-meeting check (docs/parity/m8.md, B2 step 2).
 * The same real meeting on a Google and an Outlook calendar shares an
 * iCalendar UID. Whichever provider syncs first creates the meeting (and the
 * M7 bot session); a later row that matches is non-canonical: no meeting,
 * no bot sync.
 *
 * The iCalUID is attacker-controlled (anyone can send an invite carrying any
 * UID, organizer and start), so it never identifies a meeting on its own.
 * A candidate row is adopted only when ALL of these hold:
 *   - same workspace (never across workspaces);
 *   - same iCalUID and same `starts_at` (Google gives every instance of a
 *     recurring series the series UID, so the start is required too);
 *   - the same bot target: the supported meeting link (platform + native
 *     meeting id) of both events is equal — a forged invite with another
 *     link never suppresses the real meeting or redirects its bot;
 *   - and either the same principal owns the existing meeting, or the
 *     existing meeting is visible to the workspace (`workspace`/`link`),
 *     has the same organizer and has a link.
 * Otherwise both rows keep their own meeting and the M7 per-workspace
 * live-target constraint decides about bots. Another user's private
 * meeting is never adopted (nor revealed) by someone else's calendar row.
 */
import { extractCalendarMeetingLink } from "@/lib/bot/calendar-links"
import type { CalendarEventLike } from "@/lib/bot/types"

/** The `pg` Pool/PoolClient (or PGlite) subset used here. */
export type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

export type CanonicalLookup = {
  workspaceId: string
  icalUid: string | null | undefined
  startsAt: string | null | undefined
  /** The row being synced; excluded from the match. */
  calendarEventId: string
  organizerEmail: string | null | undefined
  /** The event being synced (its bot link must equal the candidate's). */
  event: CalendarEventLike
  /** Who owns the calendar being synced (connection user / DWD subject). */
  owner: { userId?: string; email?: string }
}

/** The meeting id this calendar row already owns, if any. */
export async function ownMeetingId(db: Queryable, workspaceId: string, calendarEventId: string): Promise<string | undefined> {
  const result = await db.query(
    "select id from meetings where calendar_event_id = $1 and workspace_id = $2 limit 1",
    [calendarEventId, workspaceId]
  )

  return (result.rows[0] as { id?: string } | undefined)?.id
}

/** `platform:nativeMeetingId` of the event's bot link, or undefined. */
export function meetingLinkKey(event: CalendarEventLike | null | undefined): string | undefined {
  const link = event ? extractCalendarMeetingLink(event) : undefined

  return link ? `${link.platform}:${link.nativeMeetingId}` : undefined
}

function lower(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase()

  return trimmed || undefined
}

type CandidateRow = {
  meeting_id: string
  owner_user_id: string | null
  owner_email: string | null
  visibility: string | null
  organizer_email: string | null
  raw: unknown
}

/**
 * The meeting owned by ANOTHER calendar row that is safely the same meeting
 * (see the module comment), or undefined (this row then stays canonical).
 */
export async function findCanonicalMeetingId(db: Queryable, lookup: CanonicalLookup): Promise<string | undefined> {
  const icalUid = lookup.icalUid?.trim()

  if (!icalUid || !lookup.startsAt) return undefined

  const result = await db.query(
    `select m.id as meeting_id, m.owner_user_id, lower(u.email) as owner_email, m.visibility,
            ce.organizer_email, ce.raw
       from calendar_events ce
       join meetings m on m.calendar_event_id = ce.id and m.workspace_id = $1
       left join users u on u.id = m.owner_user_id
      where ce.workspace_id = $1
        and ce.ical_uid = $2
        and ce.starts_at = $3::timestamptz
        and ce.id <> $4
        -- A cancelled or deleted canonical event no longer suppresses its
        -- duplicates: they are promoted on their next sync.
        and coalesce(ce.status, '') <> 'cancelled'
        and m.status <> 'failed'
      order by m.created_at asc, m.id asc
      limit 20`,
    [lookup.workspaceId, icalUid, lookup.startsAt, lookup.calendarEventId]
  )
  const ownKey = meetingLinkKey(lookup.event)
  const organizer = lower(lookup.organizerEmail)
  const ownerEmail = lower(lookup.owner.email)

  for (const row of result.rows as CandidateRow[]) {
    if (meetingLinkKey(row.raw as CalendarEventLike) !== ownKey) continue

    const samePrincipal =
      (lookup.owner.userId !== undefined && row.owner_user_id === lookup.owner.userId) ||
      (ownerEmail !== undefined && row.owner_email === ownerEmail)

    if (samePrincipal) return row.meeting_id

    const visibleToWorkspace = row.visibility === "workspace" || row.visibility === "link"

    if (visibleToWorkspace && ownKey && organizer && lower(row.organizer_email) === organizer) return row.meeting_id
  }

  return undefined
}

/** A pool (with `connect`) or a single connection (PGlite). */
export type LockableQueryable = Queryable & {
  connect?: () => Promise<Queryable & { release(): void }>
}

const dedupeLocksInProcess = new Map<string, Promise<unknown>>()

/**
 * First-sync concurrency (M8 review fix #8): the canonical check and the
 * meeting insert for one real meeting (workspace, iCalUID, start) run under
 * a session advisory lock held on a dedicated pooled connection, so a Google
 * and an Outlook sync of the same event never both create a meeting. An
 * in-process mutex on the same key covers callers sharing one connection
 * (PGlite, where session advisory locks are re-entrant). Rows without an
 * iCalUID or a start are never deduped and run unlocked.
 */
export async function withCalendarDedupeLock<T>(
  db: LockableQueryable,
  key: { workspaceId: string; icalUid: string | null | undefined; startsAt: string | null | undefined },
  fn: (client: Queryable) => Promise<T>
): Promise<T> {
  const icalUid = key.icalUid?.trim()
  const startsAt = key.startsAt ? new Date(key.startsAt) : undefined

  if (!icalUid || !startsAt || Number.isNaN(startsAt.getTime())) return fn(db)

  const lockKey = `meetsum:calendar-dedupe:${key.workspaceId}:${icalUid}:${startsAt.toISOString()}`
  const previous = dedupeLocksInProcess.get(lockKey) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  const chained = previous.then(() => mine)

  dedupeLocksInProcess.set(lockKey, chained)
  await previous.catch(() => undefined)

  try {
    const connection = typeof db.connect === "function" ? await db.connect() : undefined
    const client: Queryable = connection ?? db

    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [lockKey])
      try {
        return await fn(client)
      } finally {
        await client.query("select pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined)
      }
    } finally {
      connection?.release()
    }
  } finally {
    release()
    if (dedupeLocksInProcess.get(lockKey) === chained) dedupeLocksInProcess.delete(lockKey)
  }
}

export type DeferredCalendarRow = {
  id: string
  raw: unknown
  title: string | null
  starts_at: string | Date | null
  ends_at: string | Date | null
  meet_link: string | null
  organizer_email: string | null
  ical_uid: string | null
  external_event_id: string | null
}

/**
 * Rows of ONE calendar (a Google identity or an Outlook connection) that
 * were skipped as non-canonical and still have no meeting (M8 review fix
 * #8): upcoming, not cancelled, with an iCalUID. Each sync re-evaluates
 * them, so a row whose canonical event was cancelled or deleted is
 * promoted (its meeting created) on the next sync even when the provider's
 * incremental feed does not return the event again.
 */
export async function listDeferredDuplicateRows(
  db: Queryable,
  scope: { workspaceId: string; googleIdentityId?: string; connectionId?: string },
  now: Date = new Date()
): Promise<DeferredCalendarRow[]> {
  const column = scope.googleIdentityId ? "google_identity_id" : "integration_connection_id"
  const owner = scope.googleIdentityId ?? scope.connectionId

  if (!owner) return []

  const result = await db.query(
    `select ce.id, ce.raw, ce.title, ce.starts_at, ce.ends_at, ce.meet_link, ce.organizer_email, ce.ical_uid, ce.external_event_id
       from calendar_events ce
      where ce.workspace_id = $1
        and ce.${column} = $2
        and ce.ical_uid is not null
        and ce.starts_at >= $3::timestamptz
        and coalesce(ce.status, '') <> 'cancelled'
        and not exists (select 1 from meetings m where m.calendar_event_id = ce.id)
      order by ce.starts_at asc
      limit 50`,
    [scope.workspaceId, owner, new Date(now.getTime() - 24 * 60 * 60_000).toISOString()]
  )

  return result.rows as DeferredCalendarRow[]
}
