/**
 * Integration dispatch hook (docs/parity/m8.md, Step 0 items 7–8). Owner:
 * Package A. Called once per platform event from `deliverPlatformEvent`
 * (lib/jobs/processor.ts); only the rule triggers (`meeting.completed`,
 * `summary.created`, `action_item.created`) enqueue `integration.dispatch`
 * (jobId `integration.dispatch:<eventId>`). Never throws.
 */
import { integrationLog } from "@/lib/integrations/core/errors"
import { dispatchJobId, getIntegrationQueuePort, type IntegrationQueuePort } from "@/lib/integrations/core/queue"
import { RULE_TRIGGERS } from "@/lib/integrations/core/types"
import type { PlatformEventName } from "@/lib/platform/events"

export type IntegrationEventInput = {
  workspaceId: string
  eventName: PlatformEventName
  /** Unique per emitted event; the dispatch job id is `integration.dispatch:<eventId>`. */
  eventId: string
  meetingId: string
  actionItemId?: string
}

export async function enqueueIntegrationEvent(input: IntegrationEventInput, queue?: IntegrationQueuePort): Promise<void> {
  try {
    if (!input.workspaceId || !input.meetingId || !input.eventId) return
    if (!(RULE_TRIGGERS as readonly string[]).includes(input.eventName)) return

    await (queue ?? getIntegrationQueuePort()).enqueue(
      "integration.dispatch",
      {
        workspaceId: input.workspaceId,
        eventName: input.eventName,
        eventId: input.eventId,
        meetingId: input.meetingId,
        ...(input.actionItemId ? { actionItemId: input.actionItemId } : {}),
      },
      { jobId: dispatchJobId(input.eventId) }
    )
  } catch (error) {
    integrationLog.error("dispatch enqueue failed", error)
  }
}
