/**
 * Action-item priority bumps from urgency words and due dates (owner:
 * Package B). Step 0 stub: returns the input priority.
 */
import type { ActionItem } from "@/lib/meetings/repository"

export type InferPriorityContext = {
  /** ISO datetime the meeting started. */
  anchor: string
  timeZone?: string
  /** Source quote / title text scanned for urgency words. */
  text?: string
}

export function inferPriority(
  item: Pick<ActionItem, "priority" | "dueOn" | "title" | "sourceQuote">,
  ctx: InferPriorityContext
): NonNullable<ActionItem["priority"]> {
  void ctx
  return item.priority ?? "normal"
}
