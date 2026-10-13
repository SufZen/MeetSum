/**
 * M7 meeting bot (Vexa sidecar): shared domain types. See docs/parity/m7.md
 * "Model and rules". Owned by Package A; every other bot module and the UI
 * import from here.
 */

export const BOT_PLATFORMS = ["google_meet", "teams", "zoom"] as const
export type BotPlatform = (typeof BOT_PLATFORMS)[number]

export const BOT_STATUSES = [
  "scheduled",
  "requested",
  "joining",
  "awaiting_admission",
  "needs_help",
  "active",
  "stopping",
  "completed",
  "failed",
  "blocked",
  "cancelled",
] as const
export type BotStatus = (typeof BOT_STATUSES)[number]

/** A bot is in (or on its way into) the meeting. One per target instance-wide. */
export const LIVE_BOT_STATUSES = [
  "requested",
  "joining",
  "awaiting_admission",
  "needs_help",
  "active",
  "stopping",
] as const satisfies readonly BotStatus[]
export type LiveBotStatus = (typeof LIVE_BOT_STATUSES)[number]

/** Immutable once reached. */
export const TERMINAL_BOT_STATUSES = [
  "completed",
  "failed",
  "blocked",
  "cancelled",
] as const satisfies readonly BotStatus[]
export type TerminalBotStatus = (typeof TERMINAL_BOT_STATUSES)[number]

/**
 * Transitions apply only to a higher rank; `awaiting_admission` and
 * `needs_help` may move laterally; terminal statuses never change.
 */
export const BOT_STATUS_RANK: Readonly<Record<BotStatus, number>> = {
  scheduled: 0,
  requested: 1,
  joining: 2,
  awaiting_admission: 3,
  needs_help: 3,
  active: 4,
  stopping: 5,
  completed: 6,
  failed: 6,
  blocked: 6,
  cancelled: 6,
}

export function isLiveBotStatus(status: BotStatus): status is LiveBotStatus {
  return (LIVE_BOT_STATUSES as readonly BotStatus[]).includes(status)
}

export function isTerminalBotStatus(status: BotStatus): status is TerminalBotStatus {
  return (TERMINAL_BOT_STATUSES as readonly BotStatus[]).includes(status)
}

/** Localized in the UI (lib/i18n/m7/bot.ts). */
export const BOT_STATUS_REASONS = [
  "user_stopped",
  "user_opt_out",
  "event_cancelled",
  "event_moved",
  "rule_disabled",
  "missed_window",
  "capacity",
  "already_in_meeting",
  "invalid_meeting_link",
  "vexa_unavailable",
  "vexa_misconfigured",
  "not_admitted",
  "removed_by_host",
  "platform_blocked",
  "bot_signed_out",
  "left_alone",
  "no_recording",
  "stale",
  "meeting_deleted",
  "unknown",
] as const
export type BotStatusReason = (typeof BOT_STATUS_REASONS)[number]

export const BOT_ORIGINS = ["manual", "meeting_request", "calendar_rule"] as const
export type BotOrigin = (typeof BOT_ORIGINS)[number]

export const BOT_CONSENT_STATUSES = [
  "pending",
  "sent",
  "unsupported",
  "failed",
  "disabled",
] as const
export type BotConsentStatus = (typeof BOT_CONSENT_STATUSES)[number]

export const BOT_RECORDING_STATUSES = [
  "none",
  "pending",
  "importing",
  "imported",
  "missing",
  "failed",
] as const
export type BotRecordingStatus = (typeof BOT_RECORDING_STATUSES)[number]

/** A bot_sessions row in camelCase. Never carries the encrypted passcode. */
export type BotSession = {
  id: string
  workspaceId: string
  meetingId: string | null
  origin: BotOrigin
  platform: BotPlatform
  nativeMeetingId: string
  meetingUrlRedacted: string | null
  teamsBaseHost: string | null
  vexaMeetingId: string | null
  status: BotStatus
  statusRank: number
  statusReason: BotStatusReason | null
  requestedByUserId: string | null
  calendarEventId: string | null
  scheduledStart: string | null
  scheduledEnd: string | null
  dispatchAt: string | null
  dispatchRev: number
  botName: string
  language: string | null
  recordingEnabled: boolean
  transcribeEnabled: boolean
  consentStatus: BotConsentStatus
  requestedAt: string | null
  joinedAt: string | null
  leftAt: string | null
  lastEventAt: string | null
  recordingStatus: BotRecordingStatus
  recordingStorageKey: string | null
  mediaAssetId: string | null
  ingestJobId: string | null
  /** MeetTimelineEntry[] built from bot-observed speaker names. */
  speakerTimeline: unknown
  vexaPurgedAt: string | null
  /** Redacted, at most 500 characters. */
  error: string | null
  attempts: number
  createdAt: string
  updatedAt: string
}

/**
 * Server-only store record: the session plus `passcode_enc` (an
 * encryptSecret() ciphertext) for the dispatcher. Never serialize it; APIs
 * return BotSessionSummary.
 */
export type BotSessionRecord = BotSession & { passcodeEnc: string | null }

/** What APIs and the UI see. No passcode, no raw URL. */
export type BotSessionSummary = {
  id: string
  meetingId: string | null
  status: BotStatus
  statusReason: BotStatusReason | null
  platform: BotPlatform
  scheduledStart: string | null
  joinedAt: string | null
  leftAt: string | null
  consentStatus: BotConsentStatus
  recordingStatus: BotRecordingStatus
  botName: string
}

export function toBotSessionSummary(session: BotSession): BotSessionSummary {
  return {
    id: session.id,
    meetingId: session.meetingId,
    status: session.status,
    statusReason: session.statusReason,
    platform: session.platform,
    scheduledStart: session.scheduledStart,
    joinedAt: session.joinedAt,
    leftAt: session.leftAt,
    consentStatus: session.consentStatus,
    recordingStatus: session.recordingStatus,
    botName: session.botName,
  }
}

export type MeetingLinkSource =
  | "conference_data"
  | "hangout_link"
  | "location"
  | "description"
  | "input"

/** A supported meeting link, parsed without fetching anything. */
export type ParsedMeetingLink = {
  platform: BotPlatform
  nativeMeetingId: string
  passcode?: string
  teamsBaseHost?: string
  /** https URL rebuilt from an allowlisted host; may carry the passcode. */
  canonicalUrl: string
  /** canonicalUrl without `pwd`/`p` values or the Teams `context` query. */
  redactedUrl: string
  source: MeetingLinkSource
}

/** Why an input yielded no supported link (Join-now 400 `{reason}`, dialog preview). */
export const MEETING_LINK_REJECT_REASONS = [
  "no_link",
  "unsupported_host",
  "personal_link",
  "lookup_link",
  "credentials_in_url",
  "too_long",
] as const
export type MeetingLinkRejectReason = (typeof MEETING_LINK_REJECT_REASONS)[number]

export const BOT_AUTO_JOIN_MODES = ["off", "all", "external_only", "owner_only"] as const
export type BotAutoJoinMode = (typeof BOT_AUTO_JOIN_MODES)[number]

export const BOT_LANGUAGE_MODES = ["meeting", "he", "en", "auto"] as const
export type BotLanguageMode = (typeof BOT_LANGUAGE_MODES)[number]

/** workspace_settings(key='botRules'). */
export type BotRules = {
  autoJoin: BotAutoJoinMode
  /** 0-600. */
  joinLeadSeconds: number
  /** 1-60 characters; must signal recording (see consent rules). */
  botName: string
  consentEnabled: boolean
  /** 1-500 characters each, no URLs; `{owner}` placeholder. */
  consentMessage: { he: string; en: string }
  languageMode: BotLanguageMode
  minAttendees: number
  skipTitlePatterns: string[]
  /** Added to member email domains and MEETSUM_BOT_INTERNAL_DOMAINS. */
  internalDomains: string[]
  consentAcknowledgedAt: string | null
  consentAcknowledgedByUserId: string | null
}

/** PUT /api/settings/bot body. `acknowledgeConsent` stamps time and actor. */
export type BotRulesPatch = Partial<
  Omit<BotRules, "consentAcknowledgedAt" | "consentAcknowledgedByUserId">
> & { acknowledgeConsent?: boolean }

export const DEFAULT_BOT_NAME = "MeetSum Notetaker"

export const DEFAULT_CONSENT_MESSAGE = {
  he: "שלום, כאן MeetSum Notetaker. הפגישה מוקלטת ומתומללת עבור {owner}. מי שאינו מסכים להקלטה יכול לבקש מהמארח להוציא אותי.",
  en: "Hi, this is MeetSum Notetaker. This meeting is being recorded and transcribed for {owner}. If you don't consent, ask the host to remove me.",
} as const

export const DEFAULT_BOT_RULES: Readonly<BotRules> = Object.freeze({
  autoJoin: "off",
  joinLeadSeconds: 60,
  botName: DEFAULT_BOT_NAME,
  consentEnabled: true,
  consentMessage: { ...DEFAULT_CONSENT_MESSAGE },
  languageMode: "meeting",
  minAttendees: 2,
  skipTitlePatterns: [],
  internalDomains: [],
  consentAcknowledgedAt: null,
  consentAcknowledgedByUserId: null,
})

type CalendarDateLike = {
  date?: string | null
  dateTime?: string | null
  timeZone?: string | null
}

type CalendarPersonLike = {
  email?: string | null
  displayName?: string | null
  self?: boolean | null
}

/** The subset of a Google Calendar event (calendar_events.raw) the bot reads. */
export type CalendarEventLike = {
  id?: string | null
  status?: string | null
  summary?: string | null
  description?: string | null
  location?: string | null
  hangoutLink?: string | null
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType?: string | null
      uri?: string | null
      passcode?: string | null
      password?: string | null
      pin?: string | null
      meetingCode?: string | null
    }> | null
    conferenceSolution?: {
      key?: { type?: string | null } | null
      name?: string | null
    } | null
  } | null
  start?: CalendarDateLike | null
  end?: CalendarDateLike | null
  recurrence?: string[] | null
  recurringEventId?: string | null
  organizer?: CalendarPersonLike | null
  creator?: CalendarPersonLike | null
  attendees?: Array<
    CalendarPersonLike & {
      responseStatus?: string | null
      organizer?: boolean | null
      resource?: boolean | null
      optional?: boolean | null
    }
  > | null
}
