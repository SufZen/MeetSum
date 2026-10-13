/**
 * Integration dispatch hook (docs/parity/m8.md, Step 0 items 7–8). Owner:
 * Package A. Called once per platform event from `deliverPlatformEvent`
 * (lib/jobs/processor.ts); only the rule triggers (`meeting.completed`,
 * `summary.created`, `action_item.created`) enqueue `integration.dispatch`.
 *
 * Step 0: a no-op that never throws.
 */
import type { PlatformEventName } from "@/lib/platform/events"

export type IntegrationEventInput = {
  workspaceId: string
  eventName: PlatformEventName
  /** Unique per emitted event; the dispatch job id is `integration.dispatch:<eventId>`. */
  eventId: string
  meetingId: string
  actionItemId?: string
}

export async function enqueueIntegrationEvent(input: IntegrationEventInput): Promise<void> {
  void input
}
