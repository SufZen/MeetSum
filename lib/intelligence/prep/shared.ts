/**
 * Helpers shared by prep briefs and follow-up emails (M5 D4/D5).
 */
import type { ActionItem, MeetingRecord } from "@/lib/meetings/repository"

export type DocLanguage = "he" | "en"

/**
 * Output language of a generated doc: the override, else the meeting's
 * primary language (`mixed`/unknown → Hebrew, the workspace default).
 */
export function resolveDocLanguage(meeting: MeetingRecord, override?: string): DocLanguage {
  if (override === "he" || override === "en") return override

  const primary =
    meeting.intelligence?.generation?.language ??
    meeting.intelligence?.languageMetadata?.primaryLanguage ??
    meeting.languageMetadata?.primaryLanguage ??
    meeting.language

  return primary?.toLowerCase().startsWith("en") ? "en" : "he"
}

/** `YYYY-MM-DD` (or ISO datetime) → `DD.MM.YYYY`; undefined when unparsable. */
export function formatDueDate(value: string | undefined): string | undefined {
  if (!value) return undefined

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)

  return match ? `${match[3]}.${match[2]}.${match[1]}` : undefined
}

/** Calendar due date of an action item (M5 `dueOn`, else legacy `dueDate`). */
export function actionItemDue(item: Pick<ActionItem, "dueOn" | "dueDate">): string | undefined {
  return formatDueDate(item.dueOn ?? item.dueDate)
}

/** Display owner of an action item. */
export function actionItemOwner(item: Pick<ActionItem, "owner" | "ownerText">): string | undefined {
  const owner = (item.owner ?? item.ownerText)?.trim()

  return owner || undefined
}

/**
 * Decisions of a meeting: V2/legacy intelligence, else the summary. For an
 * LLM summary with V2 items only cited decisions count (no citation, no
 * claim), including rows stored before the legacy array was filtered.
 */
export function meetingDecisions(meeting: MeetingRecord): string[] {
  const intelligence = meeting.intelligence
  const items = intelligence?.items

  if (items?.length && intelligence?.generation && intelligence.generation.provider !== "heuristic") {
    return items
      .filter((item) => item.kind === "decision" && item.refs.length > 0)
      .map((item) => item.text.trim())
      .filter(Boolean)
  }

  const decisions = meeting.intelligence?.decisions?.length
    ? meeting.intelligence.decisions
    : (meeting.summary?.decisions ?? [])

  return decisions.map((decision) => decision.trim()).filter(Boolean)
}

/** Action items of a meeting (persisted summary first, then intelligence). */
export function meetingActionItems(meeting: MeetingRecord): ActionItem[] {
  return meeting.summary?.actionItems?.length
    ? meeting.summary.actionItems
    : (meeting.intelligence?.actionItems ?? [])
}

/** Collapses whitespace and caps length (prompt hygiene). */
export function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim()

  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
