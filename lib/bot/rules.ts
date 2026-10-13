import type { BotConfig } from "@/lib/bot/config"
import type {
  BotLanguageMode,
  BotRules,
  BotStatusReason,
  CalendarEventLike,
  ParsedMeetingLink,
} from "@/lib/bot/types"

/** Why an event is not auto-joined (rule_disabled is also a BotStatusReason). */
export type AutoJoinSkipReason =
  | Extract<BotStatusReason, "rule_disabled" | "missed_window" | "event_cancelled">
  | "no_link"
  | "platform_disabled"
  | "all_day"
  | "recurring_master"
  | "declined"
  | "title_skipped"
  | "too_few_attendees"
  | "not_external"
  | "not_owner"

export type AutoJoinInput = {
  rules: BotRules
  event: CalendarEventLike
  link: ParsedMeetingLink | undefined
  /** Workspace member emails (lowercase). */
  members: readonly string[]
  /** Member email domains + MEETSUM_BOT_INTERNAL_DOMAINS + rules.internalDomains. */
  internalDomains: readonly string[]
  /** The workspace DWD subject whose calendar the event came from. */
  subject: string
  now: Date
  config: BotConfig
}

export type AutoJoinDecision =
  | { join: true; dispatchAt: Date }
  | { join: false; reason: AutoJoinSkipReason }

export function emailDomain(email: string | null | undefined): string | undefined {
  const at = email?.lastIndexOf("@") ?? -1

  return email && at > 0 ? email.slice(at + 1).trim().toLowerCase() : undefined
}

/** Member domains ∪ MEETSUM_BOT_INTERNAL_DOMAINS ∪ rules.internalDomains (lowercase). */
export function resolveInternalDomains(
  members: readonly string[],
  config: Pick<BotConfig, "internalDomains">,
  rules: Pick<BotRules, "internalDomains">
): string[] {
  const domains = new Set<string>()

  for (const email of members) {
    const domain = emailDomain(email)

    if (domain) domains.add(domain)
  }
  for (const domain of [...config.internalDomains, ...rules.internalDomains]) {
    const value = domain.trim().toLowerCase().replace(/^@/, "")

    if (value) domains.add(value)
  }

  return [...domains]
}

function eventTimes(event: CalendarEventLike) {
  const start = event.start?.dateTime ? Date.parse(event.start.dateTime) : Number.NaN
  const end = event.end?.dateTime ? Date.parse(event.end.dateTime) : Number.NaN

  return { start, end: Number.isFinite(end) ? end : undefined }
}

/** The latest moment a bot may still join (`end ?? start + late-join max`). */
export function joinWindowEnd(
  start: number,
  end: number | undefined,
  lateJoinMaxMinutes: number
): number {
  const late = start + lateJoinMaxMinutes * 60_000

  return end === undefined ? late : Math.min(end, late)
}

function titleSkipped(title: string, patterns: readonly string[]): boolean {
  const haystack = title.normalize("NFKC").toLocaleLowerCase()

  return patterns.some((pattern) => {
    const needle = pattern.normalize("NFKC").trim().toLocaleLowerCase()

    return needle.length > 0 && haystack.includes(needle)
  })
}

/**
 * Pure auto-join evaluation (M7 A4), implementing every "always skipped" and
 * mode rule from the Model section. `dispatchAt = max(now, start - lead)`.
 *
 * Window: an event is joinable while `now <= start + LATE_JOIN_MAX` and not
 * after its end (the stricter of "start more than LATE_JOIN_MAX in the past"
 * and `now <= end ?? start + LATE_JOIN_MAX`).
 */
export function evaluateAutoJoin(input: AutoJoinInput): AutoJoinDecision {
  const { rules, event, link, config, now } = input
  const botEmail = config.accountEmail?.toLowerCase()
  const subject = input.subject.trim().toLowerCase()

  // The bot-off default and the recording-consent gate.
  if (rules.autoJoin === "off" || !rules.consentAcknowledgedAt) {
    return { join: false, reason: "rule_disabled" }
  }
  if (event.status === "cancelled") return { join: false, reason: "event_cancelled" }
  if (event.recurrence?.length) return { join: false, reason: "recurring_master" }

  const { start, end } = eventTimes(event)

  if (!Number.isFinite(start)) return { join: false, reason: "all_day" }
  if (!link) return { join: false, reason: "no_link" }
  if (!config.platforms.includes(link.platform)) return { join: false, reason: "platform_disabled" }

  const attendees = (event.attendees ?? []).filter(
    (attendee) => !attendee.resource && attendee.email?.toLowerCase() !== botEmail
  )
  const subjectDeclined = attendees.some(
    (attendee) =>
      (attendee.self || attendee.email?.toLowerCase() === subject) &&
      attendee.responseStatus === "declined"
  )

  if (subjectDeclined) return { join: false, reason: "declined" }
  if (titleSkipped(event.summary ?? "", rules.skipTitlePatterns)) {
    return { join: false, reason: "title_skipped" }
  }

  const nowMs = now.getTime()

  if (nowMs > joinWindowEnd(start, end, config.lateJoinMaxMinutes)) {
    return { join: false, reason: "missed_window" }
  }

  const present = attendees.filter((attendee) => attendee.responseStatus !== "declined")
  const headcount = Math.max(present.length, 1)

  if (headcount < rules.minAttendees) return { join: false, reason: "too_few_attendees" }

  if (rules.autoJoin === "external_only") {
    const internal = new Set(input.internalDomains.map((domain) => domain.toLowerCase()))
    const external = present.some((attendee) => {
      const domain = emailDomain(attendee.email)

      return domain !== undefined && !internal.has(domain)
    })

    if (!external) return { join: false, reason: "not_external" }
  }

  if (rules.autoJoin === "owner_only") {
    const members = new Set(input.members.map((email) => email.toLowerCase()))
    const organizer = (event.organizer?.email ?? event.creator?.email ?? "").toLowerCase()

    if (!organizer || !members.has(organizer)) return { join: false, reason: "not_owner" }
  }

  return { join: true, dispatchAt: new Date(Math.max(nowMs, start - rules.joinLeadSeconds * 1000)) }
}

/** The `language` a session sends to Vexa (undefined = auto-detect). */
export function resolveBotLanguage(
  mode: BotLanguageMode,
  meetingLanguage: string | null | undefined
): "he" | "en" | undefined {
  if (mode === "he" || mode === "en") return mode
  if (mode === "auto") return undefined

  const language = meetingLanguage?.toLowerCase() ?? ""

  if (language.startsWith("he") || language === "iw") return "he"
  if (language.startsWith("en")) return "en"
  return undefined
}

const RECORDING_SIGNAL = /record|notetaker|note taker|recorder|transcri|מקליט|הקלטה|מתמלל|תמלול/i

/**
 * The bot name must always signal recording: names that don't already say
 * so (Notetaker, Recording, מקליט…) get the localized suffix the settings UI
 * previews ("· Recording" / "· מקליט"). Kept within 60 characters.
 */
export function ensureRecordingBotName(name: string, language?: string | null): string {
  const trimmed = name.trim().replace(/\s+/g, " ") || "MeetSum Notetaker"

  if (RECORDING_SIGNAL.test(trimmed)) return trimmed.slice(0, 60)

  const suffix = language?.toLowerCase().startsWith("he") ? " · מקליט" : " · Recording"

  return `${trimmed.slice(0, 60 - suffix.length)}${suffix}`
}
