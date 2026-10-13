import { extractMeetingLinks, parseMeetingLink } from "@/lib/bot/meeting-url"
import type { CalendarEventLike, MeetingLinkSource, ParsedMeetingLink } from "@/lib/bot/types"

/**
 * Picks the bot link for a calendar event (M7 A3): conferenceData video entry
 * points, then hangoutLink, location and description; the first supported
 * link wins and `source` records where it came from. Pure; never fetches.
 */

const PASSCODE = /^[A-Za-z0-9._~-]{1,128}$/

function withEntryPasscode(
  link: ParsedMeetingLink,
  entry: { passcode?: string | null; password?: string | null }
): ParsedMeetingLink {
  if (link.passcode || link.platform === "google_meet") return link

  const passcode = [entry.passcode, entry.password]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value && PASSCODE.test(value)))

  return passcode ? { ...link, passcode } : link
}

function first(text: string | null | undefined, source: MeetingLinkSource) {
  return text ? extractMeetingLinks(text, source)[0] : undefined
}

export function extractCalendarMeetingLink(
  event: CalendarEventLike
): ParsedMeetingLink | undefined {
  for (const entry of event.conferenceData?.entryPoints ?? []) {
    if (entry?.entryPointType !== "video" || !entry.uri) continue

    const link = parseMeetingLink(entry.uri, "conference_data")

    if (link) return withEntryPasscode(link, entry)
  }

  if (event.hangoutLink) {
    const link = parseMeetingLink(event.hangoutLink, "hangout_link")

    if (link) return link
  }

  return first(event.location, "location") ?? first(event.description, "description")
}

/** True when the event carries any supported Meet/Zoom/Teams link. */
export function hasConferenceLink(event: CalendarEventLike): boolean {
  return extractCalendarMeetingLink(event) !== undefined
}
