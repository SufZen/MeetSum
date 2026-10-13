/**
 * Action-item priority bumps from urgency words and due dates
 * (docs/parity/m5.md B3; owner: Package B). Pure. Never lowers the model's
 * priority:
 * - at least `high` for דחוף/בהקדם/קריטי/ASAP/urgent or a due date within
 *   2 days of the anchor;
 * - `urgent` for "דחוף מאוד"/"very urgent", "היום"/"today", or a due date
 *   that is already past when the task is created.
 */
import type { ActionItem } from "@/lib/meetings/repository"
import { daysBetween, DEFAULT_DUE_DATE_TIME_ZONE, localDateIn } from "@/lib/tasks/due-date"

export type InferPriorityContext = {
  /** ISO datetime the meeting started. */
  anchor: string
  timeZone?: string
  /** Source quote / title text scanned for urgency words. */
  text?: string
}

type Priority = NonNullable<ActionItem["priority"]>

const RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 }

const NIQQUD = /[֑-ֽֿ-ׇ]/g
const B = "(?<![\\p{L}\\p{N}])"
const E = "(?![\\p{L}\\p{N}])"
const PREFIX = "[ושבלמכה]{0,2}"

const URGENT_WORDS = new RegExp(
  `${B}${PREFIX}(?:דחוף מאוד|דחופה מאוד|היום)${E}|${B}(?:very urgent|today)${E}`,
  "u"
)
const HIGH_WORDS = new RegExp(
  `${B}${PREFIX}(?:דחוף|דחופה|דחופים|בהקדם|קריטי|קריטית|מיידי|מיידית)${E}|${B}(?:asap|urgent|urgently|critical|immediately)${E}`,
  "u"
)

function maxPriority(a: Priority, b: Priority): Priority {
  return RANK[a] >= RANK[b] ? a : b
}

export function inferPriority(
  item: Pick<ActionItem, "priority" | "dueOn" | "title" | "sourceQuote">,
  ctx: InferPriorityContext
): Priority {
  let priority: Priority = item.priority ?? "normal"
  const text = (ctx.text ?? [item.title, item.sourceQuote].filter(Boolean).join(" "))
    .normalize("NFKC")
    .replace(NIQQUD, "")
    .toLowerCase()

  if (HIGH_WORDS.test(text)) priority = maxPriority(priority, "high")
  if (URGENT_WORDS.test(text)) priority = maxPriority(priority, "urgent")

  if (item.dueOn) {
    const anchorDate = localDateIn(ctx.anchor, ctx.timeZone ?? DEFAULT_DUE_DATE_TIME_ZONE)
    const delta = daysBetween(anchorDate, item.dueOn)

    if (delta !== undefined) {
      if (delta < 0) priority = maxPriority(priority, "urgent")
      else if (delta <= 2) priority = maxPriority(priority, "high")
    }
  }

  return priority
}
