/**
 * Rule filters (docs/parity/m8.md, "Rules"), pure. Owner: Package A. All
 * filters are optional and AND-ed. Meeting facts come from
 * `meetingFactsFromRecord`.
 */
import type { MeetingFacts, RuleFilters } from "@/lib/integrations/core/types"
import type { MeetingRecord, MeetingVisibility } from "@/lib/meetings/repository"

export const DEFAULT_FILTER_VISIBILITY: readonly MeetingVisibility[] = ["workspace", "link"]

function lower(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)
}

function domainOf(email: string): string | undefined {
  const at = email.lastIndexOf("@")

  return at > 0 ? email.slice(at + 1).trim().toLowerCase() : undefined
}

function baseLanguage(value: string): string {
  return value.trim().toLowerCase().split(/[-_]/)[0] ?? ""
}

export function meetingFactsFromRecord(meeting: MeetingRecord, workspaceId: string): MeetingFacts {
  const emails = new Set<string>()

  for (const participant of meeting.participantDetails ?? []) {
    const email = participant.email?.trim().toLowerCase()

    if (email && email.includes("@")) emails.add(email)
  }

  return {
    meetingId: meeting.id,
    workspaceId: meeting.workspaceId ?? workspaceId,
    visibility: meeting.visibility,
    ...(meeting.ownerUserId ? { ownerUserId: meeting.ownerUserId } : {}),
    contextIds: (meeting.contexts ?? []).map((context) => context.id),
    tagNames: (meeting.tags ?? []).map((tag) => String(tag)),
    participantEmails: [...emails],
    language: meeting.language,
    source: meeting.source,
    ...(meeting.durationMs !== undefined ? { durationMs: meeting.durationMs } : {}),
  }
}

export type FilterContext = {
  /** Member email domains plus MEETSUM_BOT_INTERNAL_DOMAINS (M7 `resolveInternalDomains`). */
  internalDomains: readonly string[]
  /**
   * A rule with `include_private` evaluates private meetings too when it
   * sets no visibility filter (the privacy gate still decides).
   */
  includePrivate?: boolean
}

export function matchesRuleFilters(filters: RuleFilters, facts: MeetingFacts, context: FilterContext): boolean {
  const visibility: MeetingVisibility = facts.visibility ?? "private"
  const allowedVisibility =
    filters.visibility?.length
      ? filters.visibility
      : context.includePrivate
        ? [...DEFAULT_FILTER_VISIBILITY, "private" as const]
        : DEFAULT_FILTER_VISIBILITY

  if (!allowedVisibility.includes(visibility)) return false

  if (filters.roomIds?.length && !facts.contextIds.some((id) => filters.roomIds?.includes(id))) return false

  if (filters.tagNames?.length) {
    const wanted = new Set(lower(filters.tagNames))

    if (!lower(facts.tagNames).some((tag) => wanted.has(tag))) return false
  }

  if (filters.languages?.length) {
    const wanted = new Set(filters.languages.map(baseLanguage))

    if (!wanted.has(baseLanguage(facts.language))) return false
  }

  if (filters.sources?.length && !lower(filters.sources).includes(facts.source.toLowerCase())) return false

  if (filters.minDurationMinutes !== undefined && filters.minDurationMinutes > 0) {
    if ((facts.durationMs ?? 0) < filters.minDurationMinutes * 60_000) return false
  }

  if (filters.participantDomains) {
    const domains = facts.participantEmails.map(domainOf).filter((domain): domain is string => Boolean(domain))
    const listed = new Set(lower(filters.participantDomains.domains).map((domain) => domain.replace(/^@/, "")))
    const internal = new Set(lower(context.internalDomains))

    switch (filters.participantDomains.mode) {
      case "any_external":
        if (!domains.some((domain) => !internal.has(domain))) return false
        break
      case "includes":
        if (!domains.some((domain) => listed.has(domain))) return false
        break
      case "excludes":
        if (domains.some((domain) => listed.has(domain))) return false
        break
    }
  }

  return true
}
