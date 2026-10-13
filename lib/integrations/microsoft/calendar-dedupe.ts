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
 * meeting insert for one real meeting (workspace, iCalUID, start) run in ONE
 * transaction on a dedicated pooled connection holding a transaction-level
 * advisory lock, so a Google and an Outlook sync of the same event never
 * both create a meeting, and a failure rolls everything back (never a
 * half-applied meeting). An in-process mutex on the same key covers callers
 * sharing one connection (PGlite, where advisory locks are re-entrant and a
 * transaction would span unrelated interleaved queries).
 *
 * Callers fail closed: any error here (lock, lookup, insert) means no
 * meeting for this row on this sync.
 *
 * Known limitation (by decision): when the canonical event is later
 * cancelled, a non-canonical row stays skipped (no meeting, no bot). The
 * user can still use "Join now" or re-add the event.
 */
export async function withCalendarDedupeLock<T>(
  db: LockableQueryable,
  key: { workspaceId: string; icalUid: string | null | undefined; startsAt: string | null | undefined },
  fn: (client: Queryable) => Promise<T>
): Promise<T> {
  const icalUid = key.icalUid?.trim()
  const startsAt = key.startsAt ? new Date(key.startsAt) : undefined
  // Rows without an iCalUID or start are never deduped: one key per row id is not needed.
  const lockKey =
    icalUid && startsAt && !Number.isNaN(startsAt.getTime())
      ? `meetsum:calendar-dedupe:${key.workspaceId}:${icalUid}:${startsAt.toISOString()}`
      : undefined

  if (!lockKey) return fn(db)

  const previous = dedupeLocksInProcess.get(lockKey) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  const chained = previous.then(() => mine)

  dedupeLocksInProcess.set(lockKey, chained)
  await previous.catch(() => undefined)

  try {
    if (typeof db.connect !== "function") {
      await db.query("select pg_advisory_lock(hashtext($1))", [lockKey])
      try {
        return await fn(db)
      } finally {
        await db.query("select pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined)
      }
    }

    const client = await db.connect()

    try {
      await client.query("begin")
      try {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [lockKey])
        const result = await fn(client)

        await client.query("commit")
        return result
      } catch (error) {
        await client.query("rollback").catch(() => undefined)
        throw error
      }
    } finally {
      client.release()
    }
  } finally {
    release()
    if (dedupeLocksInProcess.get(lockKey) === chained) dedupeLocksInProcess.delete(lockKey)
  }
}
