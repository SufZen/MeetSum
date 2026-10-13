/**
 * Enriches extracted action items with parsed due dates, resolved owners,
 * priority and source segments (owner: Package B). Step 0 stub: identity.
 */
import type { SmartTask } from "@/lib/intelligence"
import type { TaskEnrichContext } from "@/lib/tasks/types"

export function enrichActionItems<T extends SmartTask>(items: T[], ctx: TaskEnrichContext): T[] {
  void ctx
  return items
}
