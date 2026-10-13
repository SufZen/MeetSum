import type { BotConfig } from "@/lib/bot/config"
import type {
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

/**
 * Pure auto-join evaluation (M7 A4): `dispatchAt = max(now, start - lead)`.
 * Step 0 stub: never joins.
 */
export function evaluateAutoJoin(input: AutoJoinInput): AutoJoinDecision {
  void input

  return { join: false, reason: "rule_disabled" }
}
