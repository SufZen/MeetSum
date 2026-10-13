/**
 * Shared semantics of a user action-item edit (M5 B5), used by both
 * repositories so Postgres and in-memory behave the same. Pure.
 */
import type { ActionItemPatch } from "@/lib/meetings/repository"
import { dueDateFromDueOn, localDateIn, parseDueDate } from "@/lib/tasks/due-date"

export type ResolvedDuePatch = {
  dueOn: string | null
  dueText: string | null
  dueSource: "user" | null
  /** `due_date` kept in sync for legacy readers. */
  dueDate: string | null
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return false

  const date = new Date(`${value}T00:00:00Z`)

  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** True when the patch edits the item's content (not just its status). */
export function isContentPatch(patch: ActionItemPatch): boolean {
  return (
    patch.title !== undefined ||
    patch.priority !== undefined ||
    hasOwnerPatch(patch) ||
    hasDuePatch(patch)
  )
}

export function hasOwnerPatch(patch: ActionItemPatch): boolean {
  return (
    patch.owner !== undefined ||
    patch.ownerText !== undefined ||
    patch.ownerParticipantId !== undefined ||
    patch.ownerUserId !== undefined
  )
}

export function hasDuePatch(patch: ActionItemPatch): boolean {
  return patch.dueOn !== undefined || patch.dueText !== undefined || patch.dueDate !== undefined
}

/**
 * Due fields of a user edit. An explicit `dueOn` wins (a chip or the date
 * input); otherwise `dueText` is parsed against the meeting start
 * (`anchor`); the legacy `dueDate` maps to its calendar day. A phrase the
 * parser cannot read is kept as text with no date.
 */
export function resolveDuePatch(
  patch: ActionItemPatch,
  anchor: string,
  timeZone: string
): ResolvedDuePatch | undefined {
  if (!hasDuePatch(patch)) return undefined

  let dueOn: string | null = null
  let dueText: string | null = patch.dueText?.trim() ? patch.dueText.trim() : null

  if (patch.dueOn !== undefined && patch.dueOn !== null) {
    if (!isDateOnly(patch.dueOn)) throw new Error(`Invalid dueOn: ${patch.dueOn}`)
    dueOn = patch.dueOn
  } else if (patch.dueOn === undefined && dueText) {
    // User input: strict, so junk around a date is not silently accepted.
    dueOn = parseDueDate(dueText, { anchor, timeZone, strict: true })?.date ?? null
  } else if (patch.dueOn === undefined && patch.dueText === undefined && patch.dueDate) {
    const parsed = new Date(patch.dueDate)

    dueOn = isDateOnly(patch.dueDate)
      ? patch.dueDate
      : Number.isNaN(parsed.getTime())
        ? null
        : localDateIn(parsed, timeZone)
    dueText = null
  }

  return {
    dueOn,
    dueText,
    dueSource: dueOn || dueText ? "user" : null,
    dueDate: dueOn ? dueDateFromDueOn(dueOn) : null,
  }
}

/** Owner text of a user edit: the explicit text, else the legacy `owner`. */
export function ownerTextOf(patch: ActionItemPatch): string | null {
  const text = patch.ownerText !== undefined ? patch.ownerText : patch.owner

  return text?.trim() ? text.trim() : null
}
