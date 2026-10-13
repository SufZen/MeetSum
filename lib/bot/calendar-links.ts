import type { CalendarEventLike, ParsedMeetingLink } from "@/lib/bot/types"

/**
 * Picks the bot link for a calendar event (M7 A3): conferenceData video entry
 * points, then hangoutLink, location and description; the first supported
 * link wins and `source` records where it came from.
 *
 * Step 0 stubs.
 */
export function extractCalendarMeetingLink(
  event: CalendarEventLike
): ParsedMeetingLink | undefined {
  void event

  return undefined
}

/** True when the event carries any supported Meet/Zoom/Teams link. */
export function hasConferenceLink(event: CalendarEventLike): boolean {
  void event

  return false
}
