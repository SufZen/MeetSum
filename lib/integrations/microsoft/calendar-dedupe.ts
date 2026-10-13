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
