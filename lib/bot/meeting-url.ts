import type {
  MeetingLinkRejectReason,
  MeetingLinkSource,
  ParsedMeetingLink,
} from "@/lib/bot/types"

/**
 * Meeting-link parsing (M7 A2). Pure, never fetches: Meet, Zoom and Teams
 * links from a URL or pasted (Hebrew) invite text, with wrapper unwrapping,
 * bidi/HTML normalization and passcode redaction. Importable by the client
 * (join-meeting dialog preview).
 *
 * Step 0 stubs: no link is ever recognised.
 */
export function parseMeetingLink(
  input: string,
  source: MeetingLinkSource = "input"
): ParsedMeetingLink | undefined {
  void input
  void source

  return undefined
}

/** Every supported link in order, de-duplicated by (platform, nativeMeetingId). */
export function extractMeetingLinks(
  text: string,
  source: MeetingLinkSource = "input"
): ParsedMeetingLink[] {
  void text
  void source

  return []
}

/** Why `input` yields no supported link (for 400 `invalid_meeting_link {reason}`). */
export function diagnoseMeetingLink(input: string): MeetingLinkRejectReason {
  void input

  return "no_link"
}
