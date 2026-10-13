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

/**
 * Never blocks the processing pipeline: the enqueue runs in the background
 * (bounded by MEETSUM_QUEUE_ENQUEUE_TIMEOUT_MS, default 5 s) and a failure
 * is only logged. Pass `options.wait` to await it (tests, scripts).
 */
export async function enqueueIntegrationEvent(
  input: IntegrationEventInput,
  queue?: IntegrationQueuePort,
  options: { wait?: boolean } = {}
): Promise<void> {
  const work = enqueueNow(input, queue)

  if (options.wait || queue) {
    await work
    return
  }
  void work
}

function timeoutMs(): number {
  const parsed = Number(process.env.MEETSUM_QUEUE_ENQUEUE_TIMEOUT_MS)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000
}

async function enqueueNow(input: IntegrationEventInput, queue?: IntegrationQueuePort): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    if (!input.workspaceId || !input.meetingId || !input.eventId) return
    if (!(RULE_TRIGGERS as readonly string[]).includes(input.eventName)) return

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("integration dispatch enqueue timed out")), timeoutMs())
      timer.unref?.()
    })
    const enqueue = (queue ?? getIntegrationQueuePort()).enqueue(
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

    await Promise.race([enqueue, timeout])
  } catch (error) {
    integrationLog.error("dispatch enqueue failed", error)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
