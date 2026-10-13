/**
 * Pure meeting-bot UI state (M7 C3): pill mapping, status-strip steps, hints
 * and actions, inbox pill precedence. No React, no DOM: tested in node.
 *
 * Cadence v2.0 rules applied here:
 * - pills only for exceptions (joining, waiting, recording, failed/blocked);
 *   scheduled, completed and cancelled get none, and there is never a "Ready";
 * - the `live` pill (the --live hue) is used for an active recording only;
 * - Play stays the meeting view's primary action, so every bot action is
 *   secondary (the stop button uses the `record` variant).
 */
import type {
  BotPlatform,
  BotSessionSummary,
  BotStatus,
  BotStatusReason,
} from "@/lib/bot/types"
import { formatDate } from "@/lib/i18n/format"
import type { BotMessageKey } from "@/lib/i18n/m7/bot"
import { FALLBACK_TIME_ZONE } from "@/lib/i18n/time-zone"

export type BotPillStatus = "processing" | "review" | "live" | "failed"

export type BotPill = { status: BotPillStatus; labelKey: BotMessageKey }

export const BOT_REASON_MESSAGE: Readonly<Record<BotStatusReason, BotMessageKey>> = {
  user_stopped: "botReasonUserStopped",
  user_opt_out: "botReasonUserOptOut",
  event_cancelled: "botReasonEventCancelled",
  event_moved: "botReasonEventMoved",
  rule_disabled: "botReasonRuleDisabled",
  missed_window: "botReasonMissedWindow",
  capacity: "botReasonCapacity",
  already_in_meeting: "botReasonAlreadyInMeeting",
  invalid_meeting_link: "botReasonInvalidMeetingLink",
  vexa_unavailable: "botReasonVexaUnavailable",
  vexa_misconfigured: "botReasonVexaMisconfigured",
  not_admitted: "botReasonNotAdmitted",
  removed_by_host: "botReasonRemovedByHost",
  platform_blocked: "botReasonPlatformBlocked",
  bot_signed_out: "botReasonBotSignedOut",
  left_alone: "botReasonLeftAlone",
  no_recording: "botReasonNoRecording",
  stale: "botReasonStale",
  meeting_deleted: "botReasonMeetingDeleted",
  unknown: "botReasonUnknown",
}

export function botReasonMessageKey(reason: BotStatusReason | null | undefined): BotMessageKey {
  return (reason && BOT_REASON_MESSAGE[reason]) || "botReasonUnknown"
}

export const BOT_PLATFORM_MESSAGE: Readonly<Record<BotPlatform, BotMessageKey>> = {
  google_meet: "botPlatformGoogleMeet",
  teams: "botPlatformTeams",
  zoom: "botPlatformZoom",
}

/** Pill for a bot status, or null when Cadence wants no pill (README §1.5, §7). */
export function botPillFor(
  status: BotStatus,
  reason?: BotStatusReason | null
): BotPill | null {
  switch (status) {
    case "requested":
    case "joining":
      return { status: "processing", labelKey: "botPillJoining" }
    case "stopping":
      return { status: "processing", labelKey: "botPillStopping" }
    case "awaiting_admission":
    case "needs_help":
      return { status: "review", labelKey: "botPillWaiting" }
    case "active":
      return { status: "live", labelKey: "botPillRecording" }
    case "failed":
    case "blocked":
      return { status: "failed", labelKey: botReasonMessageKey(reason) }
    case "scheduled":
    case "completed":
    case "cancelled":
      return null
  }
}

const PILL_PRECEDENCE: Readonly<Record<BotPillStatus, number>> = {
  live: 4,
  review: 3,
  failed: 2,
  processing: 1,
}

/**
 * Inbox row: one pill, live > review > failed > processing. `candidates` are
 * the bot pill and the meeting's own pipeline pill (either may be null).
 */
export function pickInboxPill<T extends { status: BotPillStatus }>(
  ...candidates: Array<T | null | undefined>
): T | null {
  let best: T | null = null

  for (const candidate of candidates) {
    if (!candidate) continue
    if (!best || PILL_PRECEDENCE[candidate.status] > PILL_PRECEDENCE[best.status]) {
      best = candidate
    }
  }

  return best
}

/* ----------------------------------------------------------- the strip */

/** The showcase's five steps (design-system/showcase/cadence.js BOT). */
export const BOT_STEPS = ["scheduled", "joining", "waiting", "recording", "processing"] as const
export type BotStep = (typeof BOT_STEPS)[number]

export const BOT_STEP_MESSAGE: Readonly<Record<BotStep, BotMessageKey>> = {
  scheduled: "botStepScheduled",
  joining: "botStepJoining",
  waiting: "botStepWaiting",
  recording: "botStepRecording",
  processing: "botStepProcessing",
}

/** Tone of the current step: the showcase's info / warn / live / danger. */
export type BotStepTone = "info" | "warn" | "live" | "danger"

export type BotStepState = {
  /** Index into BOT_STEPS of the current step. */
  current: number
  tone: BotStepTone
  /** Label shown on the current step (may differ from the step name, e.g. Blocked). */
  labelKey: BotMessageKey
}

export function botStepFor(
  session: Pick<BotSessionSummary, "status" | "statusReason" | "joinedAt">
): BotStepState | null {
  switch (session.status) {
    case "scheduled":
      return { current: 0, tone: "info", labelKey: "botStepScheduled" }
    case "requested":
    case "joining":
      return { current: 1, tone: "info", labelKey: "botStepJoining" }
    case "awaiting_admission":
    case "needs_help":
      return { current: 2, tone: "warn", labelKey: "botStepWaiting" }
    case "active":
      return { current: 3, tone: "live", labelKey: "botStepRecording" }
    case "stopping":
      return { current: 3, tone: "info", labelKey: "botStepStopping" }
    case "completed":
      return { current: 4, tone: "info", labelKey: "botStepProcessing" }
    case "failed":
    case "blocked": {
      // Stop on the step where it went wrong (the showcase's `at`).
      const current = session.joinedAt
        ? 3
        : session.statusReason === "not_admitted" || session.statusReason === "removed_by_host"
          ? 2
          : 1

      return {
        current,
        tone: "danger",
        labelKey: session.status === "blocked" ? "botStepBlocked" : "botStepFailed",
      }
    }
    case "cancelled":
      return null
  }
}

const OPEN_STATUSES: ReadonlySet<BotStatus> = new Set([
  "scheduled",
  "requested",
  "joining",
  "awaiting_admission",
  "needs_help",
  "active",
  "stopping",
])

export function isOpenBotStatus(status: BotStatus): boolean {
  return OPEN_STATUSES.has(status)
}

export const STRIP_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The header strip shows while a session is open, or failed/blocked within
 * the last 24 hours (the failure time is `leftAt`, else the scheduled start).
 */
export function shouldShowBotStrip(
  session: BotSessionSummary | null | undefined,
  now: number
): boolean {
  if (!session) return false
  if (isOpenBotStatus(session.status)) return true
  if (session.status !== "failed" && session.status !== "blocked") return false

  const at = Date.parse(session.leftAt ?? session.joinedAt ?? session.scheduledStart ?? "")

  return Number.isNaN(at) || now - at <= STRIP_FAILURE_WINDOW_MS
}

export type BotHint = {
  key: BotMessageKey
  /** `{name}` and `{platform}` are rendered by the component (names in <bdi>). */
  params?: { name?: string; platform?: BotMessageKey; time?: string }
  tone: "default" | "warn" | "danger"
}

export function botHintFor(session: BotSessionSummary): BotHint | null {
  switch (session.status) {
    case "scheduled":
      return session.scheduledStart
        ? { key: "botScheduledAt", params: { time: session.scheduledStart }, tone: "default" }
        : null
    case "requested":
    case "joining":
      return {
        key: "botHintJoining",
        params: { platform: BOT_PLATFORM_MESSAGE[session.platform], name: session.botName },
        tone: "default",
      }
    case "awaiting_admission":
      return { key: "botHintAdmit", params: { name: session.botName }, tone: "warn" }
    case "needs_help":
      return { key: "botHintNeedsHelp", params: { name: session.botName }, tone: "warn" }
    case "active":
      return session.consentStatus === "unsupported" || session.consentStatus === "failed"
        ? { key: "botHintAnnounce", tone: "warn" }
        : session.consentStatus === "sent"
          ? { key: "botHintRecording", tone: "default" }
          : null
    case "stopping":
      return { key: "botHintStopping", tone: "default" }
    case "completed":
      return { key: "botHintProcessing", tone: "default" }
    case "failed":
    case "blocked":
      return { key: botReasonMessageKey(session.statusReason), tone: "danger" }
    case "cancelled":
      return null
  }
}

export type BotStripAction =
  | "send"
  | "dont_send"
  | "stop"
  | "record_browser"
  | "import_desktop"

/**
 * Secondary actions for the strip. `canSend` comes from GET
 * /api/meetings/[id]/bot; `canWrite` is `meeting:write` on the meeting.
 */
export function botStripActions(
  session: BotSessionSummary | null | undefined,
  { canSend, canWrite, visible }: { canSend: boolean; canWrite: boolean; visible: boolean }
): BotStripAction[] {
  if (!session || !visible) return canSend ? ["send"] : []

  switch (session.status) {
    case "scheduled":
      return canWrite ? ["dont_send"] : []
    case "requested":
    case "joining":
    case "awaiting_admission":
    case "needs_help":
    case "active":
      return canWrite ? ["stop"] : []
    case "failed":
    case "blocked":
      return [...(canSend ? (["send"] as const) : []), "record_browser", "import_desktop"]
    default:
      return canSend ? ["send"] : []
  }
}

/** The `scheduledAt` meta line formats the start as a time in the viewer's zone. */
export function formatBotJoinTime(iso: string, locale: string, timeZone: string = FALLBACK_TIME_ZONE): string {
  return formatDate(iso, { locale: locale === "he" ? "he" : "en", timeZone }, "time")
}

/** Meeting ids whose bot status changed between two polls (refetch the detail view). */
export function changedBotMeetingIds(
  previous: Readonly<Record<string, Pick<BotSessionSummary, "id" | "status">>>,
  next: Readonly<Record<string, Pick<BotSessionSummary, "id" | "status">>>
): string[] {
  const ids = new Set([...Object.keys(previous), ...Object.keys(next)])
  const changed: string[] = []

  for (const id of ids) {
    const before = previous[id]
    const after = next[id]

    if (before?.id !== after?.id || before?.status !== after?.status) changed.push(id)
  }

  return changed.sort()
}
