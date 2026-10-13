/**
 * Provider-neutral meeting recap (docs/parity/m8.md, "Shared contracts").
 * Real in Step 0; owned by Package A afterwards. Every provider (Slack,
 * Notion, HubSpot, Docs, email) renders from this, so the content toggles
 * are honoured in one place. Pure: no I/O, no share-link creation.
 */
import type { RuleContent } from "@/lib/integrations/core/types"
import { isRtlLanguage } from "@/lib/integrations/bidi"
import type { MeetingRecord, MeetingVisibility } from "@/lib/meetings/repository"
import { getTaskTimeZone } from "@/lib/tasks/time-zone"

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` of an instant in `timeZone`. */
function localDate(instant: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  )

  return `${parts.year}-${parts.month}-${parts.day}`
}

/**
 * The date-only due date of an action item (M8 e2e fix #8): `dueOn` when
 * set, a date-only `dueDate`, else the LOCAL date (Asia/Jerusalem by
 * default, `MEETSUM_DEFAULT_TIMEZONE`) of a timestamp `dueDate`, so
 * 2026-10-19T23:00Z is 2026-10-20 and never shows as the day before.
 */
export function recapDueOn(item: { dueOn?: string | null; dueDate?: string | null }, timeZone: string = getTaskTimeZone()): string | undefined {
  if (item.dueOn && DATE_ONLY.test(item.dueOn)) return item.dueOn
  if (!item.dueDate) return undefined
  if (DATE_ONLY.test(item.dueDate)) return item.dueDate

  const instant = new Date(item.dueDate)

  return Number.isNaN(instant.getTime()) ? undefined : localDate(instant, timeZone)
}

/** A date-only due date for display: `20.10.2026` (he), `Oct 20, 2026` (en). */
export function formatRecapDueDate(dueOn: string, locale: "he" | "en"): string {
  if (!DATE_ONLY.test(dueOn)) return dueOn

  const [year, month, day] = dueOn.split("-").map(Number)
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12))

  return locale === "he"
    ? new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" }).format(noonUtc)
    : new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(noonUtc)
}

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  )
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))

  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/** 23:59:59 local time on `dueOn` in `timeZone`, as a UTC ISO instant. */
export function dueEndOfDayIso(dueOn: string, timeZone: string = getTaskTimeZone()): string {
  const [year, month, day] = dueOn.split("-").map(Number)
  const guess = Date.UTC(year, month - 1, day, 23, 59, 59)
  const first = guess - zoneOffsetMs(new Date(guess), timeZone)

  return new Date(guess - zoneOffsetMs(new Date(first), timeZone)).toISOString()
}

export type MeetingRecapActionItem = {
  id: string
  title: string
  owner?: string
  ownerEmail?: string
  /** `YYYY-MM-DD` when known. */
  dueDate?: string
  priority?: "low" | "normal" | "high" | "urgent"
  status: "open" | "done"
}

export type MeetingRecap = {
  meetingId: string
  title: string
  language: string
  dir: "rtl" | "ltr"
  startedAt: string
  durationMs?: number
  participants: { name: string; email?: string }[]
  overview?: string
  actionItems: MeetingRecapActionItem[]
  decisions: string[]
  openQuestions: string[]
  chapters?: { title: string; startMs: number }[]
  /** Only when `content.transcript` is set. */
  transcript?: { startMs: number; speaker: string; text: string; language?: string }[]
  links: { meeting?: string; share?: string }
  /** Unknown visibility is reported as private. */
  visibility: MeetingVisibility
}

/** Default rule content (docs/parity/m8.md, "Rules"). */
export const DEFAULT_RULE_CONTENT: RuleContent = {
  overview: true,
  actionItems: true,
  decisions: true,
  openQuestions: false,
  transcript: false,
  link: "app",
}

export type BuildMeetingRecapOptions = {
  content: RuleContent
  /**
   * Candidate links resolved by the caller: the app URL and, when the
   * meeting already has an active share, its URL. Filtered by `content.link`.
   */
  links: { meeting?: string; share?: string }
}

function nonEmpty(values: readonly (string | undefined | null)[] | undefined): string[] {
  return (values ?? []).map((value) => value?.trim() ?? "").filter(Boolean)
}

function participantsOf(meeting: MeetingRecord): MeetingRecap["participants"] {
  const seen = new Set<string>()
  const result: MeetingRecap["participants"] = []

  if (meeting.participantDetails?.length) {
    for (const participant of meeting.participantDetails) {
      const email = participant.email?.trim().toLowerCase() || undefined
      const name = participant.name?.trim() || email || ""
      const key = email ?? `name:${name}`

      if (!name || seen.has(key)) continue
      seen.add(key)
      result.push(email ? { name, email } : { name })
    }

    return result
  }

  for (const raw of meeting.participants ?? []) {
    const name = raw.trim()

    if (!name || seen.has(`name:${name}`)) continue
    seen.add(`name:${name}`)
    result.push({ name })
  }

  return result
}

/** M5 IntelligenceV2 items of a kind, else the legacy list. */
function itemsOrLegacy(
  meeting: MeetingRecord,
  kind: "decision" | "open_question",
  legacy: readonly string[] | undefined
): string[] {
  const items = meeting.intelligence?.items

  if (items?.length) {
    const texts = nonEmpty(items.filter((item) => item.kind === kind).map((item) => item.text))

    if (texts.length) return texts
  }

  return nonEmpty(legacy)
}

function linksFor(content: RuleContent, links: BuildMeetingRecapOptions["links"]): MeetingRecap["links"] {
  if (content.link === "none") return {}

  const result: MeetingRecap["links"] = {}

  if (links.meeting) result.meeting = links.meeting
  if (content.link === "existing_share" && links.share) result.share = links.share

  return result
}

export function buildMeetingRecap(meeting: MeetingRecord, options: BuildMeetingRecapOptions): MeetingRecap {
  const { content } = options
  const overview = (meeting.summary?.overview || meeting.intelligence?.overview || "").trim()
  const chapters = (meeting.intelligence?.chapters ?? [])
    .filter((chapter) => chapter.title?.trim())
    .map((chapter) => ({ title: chapter.title.trim(), startMs: chapter.startMs }))

  const recap: MeetingRecap = {
    meetingId: meeting.id,
    title: meeting.title,
    language: meeting.language,
    dir: isRtlLanguage(meeting.language) ? "rtl" : "ltr",
    startedAt: meeting.startedAt,
    participants: participantsOf(meeting),
    actionItems: content.actionItems
      ? (meeting.summary?.actionItems ?? []).map((item) => {
          const owner = item.owner?.trim() || item.ownerText?.trim() || undefined
          const dueDate = recapDueOn(item)

          return {
            id: item.id,
            title: item.title,
            ...(owner ? { owner } : {}),
            ...(dueDate ? { dueDate } : {}),
            ...(item.priority ? { priority: item.priority } : {}),
            status: item.status,
          }
        })
      : [],
    decisions: content.decisions
      ? itemsOrLegacy(meeting, "decision", meeting.summary?.decisions?.length ? meeting.summary.decisions : meeting.intelligence?.decisions)
      : [],
    openQuestions: content.openQuestions
      ? itemsOrLegacy(meeting, "open_question", meeting.intelligence?.openQuestions)
      : [],
    links: linksFor(content, options.links),
    visibility: meeting.visibility ?? "private",
  }

  if (meeting.durationMs !== undefined) recap.durationMs = meeting.durationMs
  if (content.overview && overview) recap.overview = overview
  if (chapters.length) recap.chapters = chapters
  if (content.transcript) {
    recap.transcript = (meeting.transcript ?? []).map((segment) => ({
      startMs: segment.startMs,
      speaker: segment.speaker,
      text: segment.text,
      ...(segment.language ? { language: segment.language } : {}),
    }))
  }

  return recap
}
