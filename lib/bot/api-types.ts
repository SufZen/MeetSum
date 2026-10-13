import type {
  BotPlatform,
  BotRules,
  BotRulesPatch,
  BotSessionSummary,
  BotStatus,
  BotStatusReason,
  MeetingLinkRejectReason,
} from "@/lib/bot/types"

/**
 * Bot route DTOs (M7 B7/B8). Owned by Package B; Package C's UI relies on
 * them. Responses never carry passcodes or raw meeting URLs.
 */

export type BotJoinLanguage = "he" | "en" | "auto"

export type BotErrorCode =
  | "bot_disabled"
  | "bot_rate_limited"
  | "bot_capacity"
  | "invalid_meeting_link"
  | "bot_already_in_meeting"
  | "bot_session_terminal"
  | "bot_provider_unavailable"
  | "bot_no_link"
  | "consent_ack_required"
  | "live_unavailable"
  | "validation_failed"
  | "not_found"
  | "forbidden"

export type BotErrorResponse = {
  error: BotErrorCode
  /** invalid_meeting_link: why nothing usable was found. */
  reason?: MeetingLinkRejectReason
  /** validation_failed: per-field messages (settings PUT). */
  fields?: Record<string, string>
}

/** Minimal meeting reference returned with a session. */
export type BotMeetingRef = {
  id: string
  title: string
  status: string
  startedAt: string | null
}

/** POST /api/meetings/bot (meeting:create) - "Join now". */
export type JoinBotRequest = {
  meetingUrl?: string
  /** Pasted invite text (Hebrew or English) containing a link. */
  text?: string
  title?: string
  language?: BotJoinLanguage
}

/** 201 for a new session; 200 with `reused:true` for the workspace's open one. */
export type JoinBotResponse = {
  meeting: BotMeetingRef
  session: BotSessionSummary
  reused?: boolean
}

/** GET /api/meetings/[id]/bot (meeting:read). */
export type MeetingBotResponse = {
  session?: BotSessionSummary
  history: BotSessionSummary[]
  canSend: boolean
  link?: { platform: BotPlatform; redactedUrl: string }
}

/** POST /api/meetings/[id]/bot (meeting:write) - "Send bot to this meeting". */
export type SendBotRequest = {
  meetingUrl?: string
  text?: string
}

export type SendBotResponse = { session: BotSessionSummary }

/** DELETE /api/meetings/[id]/bot (meeting:write): opt out or stop. */
export type StopBotResponse = { session: BotSessionSummary }

/** GET /api/bot/sessions?active=1 (meeting:read): newest session per visible meeting. */
export type BotSessionsResponse = {
  byMeetingId: Record<string, BotSessionSummary>
}

/** GET /api/bot/status (ops:read). */
export type BotStatusResponse = {
  enabled: boolean
  vexaVersion: string
  healthy: boolean
  running: number
  capacity: { max: number; perWorkspace: number }
  webhookConfigured: boolean
}

/** GET /api/settings/bot (workspace:read). */
export type BotSettingsResponse =
  | { enabled: false }
  | {
      enabled: true
      rules: BotRules
      /** Caller has settings:write. */
      editable: boolean
      /** MEETSUM_BOT_INTERNAL_DOMAINS (read-only, shown next to rules.internalDomains). */
      envInternalDomains: string[]
    }

/** PUT /api/settings/bot (settings:write). */
export type BotSettingsUpdateRequest = BotRulesPatch

export type BotSettingsUpdateResponse = { rules: BotRules }

/** GET /api/meetings/[id]/bot/live (text/event-stream) events. */
export type BotLiveSegmentEvent = {
  id: string
  speaker: string | null
  text: string
  startMs: number
  endMs: number
  language: string | null
  final: boolean
}

export type BotLiveStatusEvent = {
  status: BotStatus
  statusReason: BotStatusReason | null
}

export type BotLiveEvent =
  | { event: "segment"; data: BotLiveSegmentEvent }
  | { event: "status"; data: BotLiveStatusEvent }
  | { event: "end"; data: BotLiveStatusEvent }
