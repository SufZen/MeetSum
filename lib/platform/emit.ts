/**
 * Platform event emitter for events outside the processing pipeline
 * (docs/parity/m8.md, Step 0 items 7–8 and C4): `action_item.updated`,
 * `clip.created`, `bot.status_changed`, `integration.delivery.failed`.
 * Owner: Package C.
 *
 * These are catalog v2 events, so only v2 webhook subscriptions receive them.
 * The payload is built by `resolveWebhookPayloadV2`, which re-reads the
 * meeting (and clip) and keeps a private meeting's payload minimal.
 *
 * Never throws: a call site must never fail its request because of a webhook.
 */
import type { MeetingRepository } from "@/lib/meetings/repository"
import {
  isWebhookEventV2,
  minimalPrivatePayload,
  resolveWebhookPayloadV2,
} from "@/lib/platform/event-payloads"
import type { PlatformEventName } from "@/lib/platform/events"

export type PlatformEventScope = {
  workspaceId: string
  /** Scoped repository, used to re-read the meeting's visibility. */
  repo?: MeetingRepository
}

type Deliver = (typeof import("@/lib/webhooks/delivery"))["deliverWebhookEvent"]

let deliverOverride: Deliver | undefined

/** Test hook: replaces the webhook fan-out. */
export function setPlatformEventDeliveryForTesting(deliver: Deliver | undefined) {
  deliverOverride = deliver
}

export async function emitPlatformEvent(
  scope: PlatformEventScope,
  name: PlatformEventName,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const workspaceId = scope.workspaceId?.trim()

    if (!workspaceId || !isWebhookEventV2(name)) return

    const dataV2 = await resolveWebhookPayloadV2(name, data, { workspaceId, ...(scope.repo ? { repo: scope.repo } : {}) })
    // v1 subscribers of a v1 event keep the raw (v1) data, minimized the same way.
    const dataV1 = dataV2.visibility === "private" ? minimalPrivatePayload(workspaceId, data) : data
    const deliver = deliverOverride ?? (await import("@/lib/webhooks/delivery")).deliverWebhookEvent

    await deliver({ eventName: name, data: dataV1, dataV2, workspaceId })
  } catch {
    // Webhooks are best-effort here; the delivery log records failures.
  }
}
