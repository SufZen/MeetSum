/**
 * Cross-provider canonical-meeting check (docs/parity/m8.md, B2 step 2).
 * The same real meeting on a Google and an Outlook calendar shares an
 * iCalendar UID. Whichever provider syncs first creates the meeting (and the
 * M7 bot session); every later row with the same `(workspace_id, ical_uid)`
 * is non-canonical: no meeting, no bot sync.
 *
 * Deviation from the spec text, on purpose: the match also requires the same
 * `starts_at`. Google gives every instance of a recurring series the series'
 * iCalUID, so matching on the UID alone would collapse a weekly meeting into
 * its first occurrence. Graph gives each occurrence its own iCalUId, so
 * recurring meetings present on both calendars are not deduped (known gap).
 *
 * Scoped by workspace: a row in another workspace never matches.
 */

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
}

/** The meeting id this calendar row already owns, if any. */
export async function ownMeetingId(db: Queryable, workspaceId: string, calendarEventId: string): Promise<string | undefined> {
  const result = await db.query(
    "select id from meetings where calendar_event_id = $1 and workspace_id = $2 limit 1",
    [calendarEventId, workspaceId]
  )

  return (result.rows[0] as { id?: string } | undefined)?.id
}

/**
 * The meeting owned by ANOTHER calendar row of the same workspace with the
 * same iCalUID and start, or undefined (this row may then become canonical).
 */
export async function findCanonicalMeetingId(db: Queryable, lookup: CanonicalLookup): Promise<string | undefined> {
  const icalUid = lookup.icalUid?.trim()

  if (!icalUid || !lookup.startsAt) return undefined

  const result = await db.query(
    `select m.id
       from calendar_events ce
       join meetings m on m.calendar_event_id = ce.id and m.workspace_id = $1
      where ce.workspace_id = $1
        and ce.ical_uid = $2
        and ce.starts_at = $3::timestamptz
        and ce.id <> $4
      order by m.created_at asc, m.id asc
      limit 1`,
    [lookup.workspaceId, icalUid, lookup.startsAt, lookup.calendarEventId]
  )

  return (result.rows[0] as { id?: string } | undefined)?.id
}
