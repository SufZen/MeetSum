/**
 * Pure join-meeting dialog logic (M7 C3): the live link preview over A's
 * pure parser, the request body, and API error → message mapping. The
 * parser functions are injected so the preview is testable without the
 * real implementation (and stays a client-safe import).
 */
import type { BotErrorResponse, BotJoinLanguage, JoinBotRequest } from "@/lib/bot/api-types"
import type { MeetingLinkRejectReason, ParsedMeetingLink } from "@/lib/bot/types"
import type { BotMessageKey } from "@/lib/i18n/m7/bot"

export type JoinPreview =
  | { kind: "empty" }
  | { kind: "found"; link: ParsedMeetingLink; extraCount: number }
  | { kind: "rejected"; reason: MeetingLinkRejectReason }

export type MeetingLinkParser = {
  extract: (text: string) => ParsedMeetingLink[]
  diagnose: (text: string) => MeetingLinkRejectReason
}

export const JOIN_TEXT_MAX = 4096

export function buildJoinPreview(text: string, parser: MeetingLinkParser): JoinPreview {
  if (!text.trim()) return { kind: "empty" }
  if (text.length > JOIN_TEXT_MAX) return { kind: "rejected", reason: "too_long" }

  const links = parser.extract(text)

  if (links.length === 0) return { kind: "rejected", reason: parser.diagnose(text) }

  return { kind: "found", link: links[0], extraCount: links.length - 1 }
}

export const LINK_REASON_MESSAGE: Readonly<Record<MeetingLinkRejectReason, BotMessageKey>> = {
  no_link: "botLinkNoLink",
  unsupported_host: "botLinkUnsupportedHost",
  personal_link: "botLinkPersonalLink",
  lookup_link: "botLinkLookupLink",
  credentials_in_url: "botLinkCredentials",
  too_long: "botLinkTooLong",
}

/** A bare URL goes as `meetingUrl`; anything else (pasted invite text) as `text`. */
export function buildJoinRequest({
  input,
  title,
  language,
}: {
  input: string
  title?: string
  language: BotJoinLanguage
}): JoinBotRequest {
  const trimmed = input.trim()
  const bareUrl = /^https?:\/\/\S+$/i.test(trimmed)
  const cleanTitle = title?.trim()

  return {
    ...(bareUrl ? { meetingUrl: trimmed } : { text: trimmed }),
    ...(cleanTitle ? { title: cleanTitle.slice(0, 200) } : {}),
    language,
  }
}

/** Every bot route error maps to a message that names the cause and the next step. */
export function botErrorMessageKey(
  status: number,
  body: Partial<BotErrorResponse> | null | undefined
): BotMessageKey {
  switch (body?.error) {
    case "bot_rate_limited":
      return "botErrorRateLimited"
    case "bot_capacity":
      return "botErrorCapacity"
    case "bot_already_in_meeting":
      return "botErrorAlreadyInMeeting"
    case "invalid_meeting_link":
      return LINK_REASON_MESSAGE[body.reason ?? "no_link"] ?? "botLinkNoLink"
    case "bot_session_terminal":
      return "botErrorTerminal"
    case "bot_no_link":
      return "botErrorNoLink"
    case "bot_disabled":
      return "botErrorDisabled"
    case "forbidden":
      return "botErrorForbidden"
    case "consent_ack_required":
      return "botConsentAckRequired"
    case "validation_failed":
      return "botFieldInvalid"
    case "not_found":
    case "live_unavailable":
      return "botErrorGeneric"
  }

  if (status === 429) return "botErrorRateLimited"
  if (status === 409) return "botErrorAlreadyInMeeting"
  if (status === 403) return "botErrorForbidden"
  if (status === 404) return "botErrorDisabled"
  if (status === 400) return "botLinkNoLink"
  if (status === 0) return "botErrorNetwork"

  return "botErrorGeneric"
}
