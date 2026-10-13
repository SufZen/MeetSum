/**
 * Pure Graph event → M7 `CalendarEventLike` mapping (docs/parity/m8.md, B2).
 *
 * Privacy: the event body is never kept. Only the supported meeting links
 * found in `body.content` (M7 `extractMeetingLinks`) become `description`,
 * so passcodes in free text or private notes never reach `calendar_events`.
 * `meetLink` (stored in `calendar_events.meet_link`) is the redacted URL,
 * without `pwd`/passcode values.
 */
import { extractCalendarMeetingLink } from "@/lib/bot/calendar-links"
import { extractMeetingLinks } from "@/lib/bot/meeting-url"
import type { CalendarEventLike } from "@/lib/bot/types"

type GraphDateTime = { dateTime?: string | null; timeZone?: string | null }
type GraphEmail = { emailAddress?: { name?: string | null; address?: string | null } | null }

/** The Graph `event` fields the sync reads (calendarView/delta). */
export type GraphEvent = {
  id: string
  "@removed"?: { reason?: string }
  iCalUId?: string | null
  subject?: string | null
  isCancelled?: boolean | null
  isAllDay?: boolean | null
  sensitivity?: "normal" | "personal" | "private" | "confidential" | string | null
  start?: GraphDateTime | null
  end?: GraphDateTime | null
  organizer?: GraphEmail | null
  attendees?: Array<
    GraphEmail & { type?: "required" | "optional" | "resource" | string | null; status?: { response?: string | null } | null }
  > | null
  location?: { displayName?: string | null } | null
  locations?: Array<{ displayName?: string | null }> | null
  body?: { contentType?: string | null; content?: string | null } | null
  onlineMeeting?: { joinUrl?: string | null } | null
  isOnlineMeeting?: boolean | null
  seriesMasterId?: string | null
  type?: string | null
}

export type MappedOutlookEvent = {
  externalEventId: string
  iCalUID?: string
  title: string
  startsAt: string
  endsAt?: string
  status: "confirmed" | "cancelled"
  organizerEmail?: string
  /** Redacted canonical link (no passcode), for `calendar_events.meet_link`. */
  meetLink: string | null
  /** `sensitivity ∈ {private, confidential}`: the meeting is created private. */
  isPrivate: boolean
  event: CalendarEventLike
}

const RESPONSES: Record<string, string> = {
  accepted: "accepted",
  organizer: "accepted",
  declined: "declined",
  tentativelyaccepted: "tentative",
}

/**
 * Graph returns `dateTime` without an offset in the `outlook.timezone` we
 * request (UTC). An explicit offset is honoured; any other zone is refused
 * rather than guessed.
 */
export function graphDateTimeToIso(value: GraphDateTime | null | undefined): string | undefined {
  const raw = value?.dateTime?.trim()

  if (!raw) return undefined

  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
  const zone = value?.timeZone?.trim().toLowerCase()

  if (!hasOffset && zone && zone !== "utc" && zone !== "etc/utc" && zone !== "coordinated universal time") return undefined

  const date = new Date(hasOffset ? raw : `${raw.replace(/(\.\d{3})\d*$/, "$1")}Z`)

  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function lower(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase()

  return trimmed || undefined
}

/** Undefined for all-day events and events without a usable start. */
export function mapGraphEventToCalendarEventLike(
  graph: GraphEvent,
  options: { selfEmail?: string } = {}
): MappedOutlookEvent | undefined {
  if (graph.isAllDay) return undefined

  const startsAt = graphDateTimeToIso(graph.start)

  if (!startsAt) return undefined

  const endsAt = graphDateTimeToIso(graph.end)
  const selfEmail = lower(options.selfEmail)
  const organizerEmail = lower(graph.organizer?.emailAddress?.address)
  const status = graph.isCancelled ? "cancelled" : "confirmed"
  const title = graph.subject?.trim() || "Untitled meeting"
  const bodyLinks = graph.body?.content ? extractMeetingLinks(graph.body.content, "description") : []
  const locationText = [graph.location?.displayName, ...(graph.locations ?? []).map((item) => item.displayName)]
    .map((value) => value?.trim())
    .filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index)
    .join("\n")
  const joinUrl = graph.onlineMeeting?.joinUrl?.trim()

  const event: CalendarEventLike = {
    id: graph.id,
    status,
    summary: title,
    description: bodyLinks.length ? bodyLinks.map((link) => link.canonicalUrl).join("\n") : null,
    location: locationText || null,
    conferenceData: joinUrl ? { entryPoints: [{ entryPointType: "video", uri: joinUrl }] } : null,
    start: { dateTime: startsAt },
    end: endsAt ? { dateTime: endsAt } : null,
    organizer: organizerEmail
      ? { email: organizerEmail, displayName: graph.organizer?.emailAddress?.name ?? null, self: organizerEmail === selfEmail }
      : null,
    attendees: (graph.attendees ?? [])
      .map((attendee) => {
        const email = lower(attendee.emailAddress?.address)

        if (!email) return undefined
        return {
          email,
          displayName: attendee.emailAddress?.name ?? null,
          responseStatus: RESPONSES[(attendee.status?.response ?? "").toLowerCase()] ?? "needsAction",
          organizer: email === organizerEmail,
          resource: attendee.type === "resource",
          optional: attendee.type === "optional",
          self: email === selfEmail,
        }
      })
      .filter((attendee): attendee is NonNullable<typeof attendee> => attendee !== undefined),
  }
  const link = extractCalendarMeetingLink(event)

  return {
    externalEventId: graph.id,
    iCalUID: graph.iCalUId?.trim() || undefined,
    title,
    startsAt,
    endsAt,
    status,
    organizerEmail,
    meetLink: link?.redactedUrl ?? null,
    isPrivate: graph.sensitivity === "private" || graph.sensitivity === "confidential",
    event,
  }
}
