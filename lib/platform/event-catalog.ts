/**
 * Webhook event catalog (docs/parity/m8.md, "Shared contracts" and C4).
 * Names and versions are FROZEN after M8 Step 0; Package C owns the file
 * afterwards (schemas, examples and descriptions live in event-schemas.ts).
 *
 * - v1: today's six events and payloads, frozen for existing subscribers.
 * - v2: the catalog version (new subscriptions default to it). It keeps the
 *   existing name `summary.created` (no rename to `summary.ready`).
 */
import type { PlatformEventName } from "@/lib/platform/events"

export const CATALOG_VERSION = 2 as const

export type WebhookPayloadVersion = 1 | 2

export const WEBHOOK_EVENTS_V1 = [
  "meeting.completed",
  "summary.created",
  "action_item.created",
  "meeting.process_failed",
  "realizeos.export.sent",
  "realizeos.export.failed",
] as const satisfies readonly PlatformEventName[]

export const WEBHOOK_EVENTS_V2 = [
  ...WEBHOOK_EVENTS_V1,
  "action_item.updated",
  "clip.created",
  "bot.status_changed",
  "integration.delivery.failed",
] as const satisfies readonly PlatformEventName[]

export type WebhookEventV1 = (typeof WEBHOOK_EVENTS_V1)[number]
export type WebhookEventV2 = (typeof WEBHOOK_EVENTS_V2)[number]

/** Events a subscription of `version` may subscribe to. */
export function webhookEventsFor(version: WebhookPayloadVersion): readonly WebhookEventV2[] {
  return version === 1 ? WEBHOOK_EVENTS_V1 : WEBHOOK_EVENTS_V2
}
