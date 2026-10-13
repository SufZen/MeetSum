/**
 * Delivery log service (docs/parity/m8.md A6/A7). Owner: Package A.
 * `meetingTitle` is shown only when the meeting is visible to the viewer
 * (otherwise `null` → "Private meeting"). Retry is allowed for `failed`,
 * `partial`, or `skipped/needs_reauth`; it resets attempts and keeps the
 * idempotency key.
 */
import { createHash, randomUUID } from "node:crypto"

import type { MeetingRepository } from "@/lib/meetings/repository"
import { auditIntegration, type IntegrationAuditActor } from "@/lib/integrations/core/audit"
import { deliveryDTO, type ManualRequest } from "@/lib/integrations/core/deliver"
import { integrationMaxAttempts } from "@/lib/integrations/core/limits"
import { deliverJobId, type IntegrationQueuePort } from "@/lib/integrations/core/queue"
import type { IntegrationStore, StoredDelivery } from "@/lib/integrations/core/store"
import type { DeliveryStatus, IntegrationDeliveryDTO } from "@/lib/integrations/core/types"

const STATUSES: readonly DeliveryStatus[] = ["queued", "running", "retrying", "sent", "partial", "skipped", "failed", "cancelled"]

export function isDeliveryStatus(value: string | null): value is DeliveryStatus {
  return Boolean(value && (STATUSES as readonly string[]).includes(value))
}

/** DTOs with `meetingTitle` resolved through the viewer's scoped repository. */
export async function toVisibleDeliveryDTOs(rows: StoredDelivery[], meetings: Pick<MeetingRepository, "getMeeting">): Promise<IntegrationDeliveryDTO[]> {
  const titles = new Map<string, string | null>()

  for (const row of rows) {
    if (!row.meetingId || titles.has(row.meetingId)) continue

    const meeting = await meetings.getMeeting(row.meetingId).catch(() => undefined)

    titles.set(row.meetingId, meeting ? meeting.title : null)
  }

  return rows.map((row) => ({
    ...deliveryDTO(row),
    ...(row.meetingId ? { meetingTitle: titles.get(row.meetingId) ?? null } : {}),
  }))
}

export function canRetry(row: StoredDelivery): boolean {
  return row.status === "failed" || row.status === "partial" || (row.status === "skipped" && row.skipReason === "needs_reauth")
}

export async function retryDelivery(
  store: IntegrationStore,
  queue: IntegrationQueuePort,
  row: StoredDelivery,
  actor: IntegrationAuditActor
): Promise<StoredDelivery | undefined> {
  const updated = await store.updateDelivery(row.workspaceId, row.id, {
    status: "queued",
    attempts: 0,
    maxAttempts: integrationMaxAttempts(),
    skipReason: null,
    lastError: null,
    completedAt: null,
  })

  if (!updated) return undefined

  await queue.enqueue("integration.deliver", { workspaceId: row.workspaceId, deliveryId: row.id }, { jobId: deliverJobId(row.id, Date.now()) })
  await auditIntegration(actor, "integration.delivery.retried", { type: "integration_delivery", id: row.id }, {
    provider: row.provider,
    deliveryId: row.id,
    origin: row.origin,
  })
  return updated
}

export type ManualSendInput = {
  workspaceId: string
  connectionId: string
  provider: StoredDelivery["provider"]
  meetingId: string
  requestedByUserId?: string
  clientKey?: string
  request: ManualRequest
}

/** Stable JSON (sorted keys) for hashing. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * What an Idempotency-Key is bound to: the meeting, provider, connection,
 * destination and content options. A replay with a different binding is a
 * client bug (or a reused key), never a silent replay of another delivery.
 */
export function manualRequestFingerprint(input: {
  meetingId?: string
  provider: string
  connectionId?: string
  request?: ManualRequest
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        meetingId: input.meetingId ?? null,
        provider: input.provider,
        connectionId: input.connectionId ?? null,
        destination: input.request?.destination ?? null,
        content: input.request?.content ?? null,
      })
    )
    .digest("hex")
}

export type ManualDeliveryResult =
  | { delivery: StoredDelivery; created: boolean; reuse?: false }
  /** The key was already used for another meeting/destination/content (→ 422). */
  | { reuse: true }

/**
 * Inserts (or replays) a manual delivery; enqueues only a new row. A replayed
 * key must carry the same request fingerprint, else `{reuse: true}`.
 */
export async function createManualDelivery(
  store: IntegrationStore,
  queue: IntegrationQueuePort,
  input: ManualSendInput
): Promise<ManualDeliveryResult> {
  const { delivery, created } = await store.insertDelivery({
    id: `intd_${randomUUID()}`,
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    provider: input.provider,
    origin: "manual",
    eventName: "manual.send",
    meetingId: input.meetingId,
    idempotencyKey: `manual:${input.requestedByUserId ?? "system"}:${input.clientKey ?? randomUUID()}`,
    status: "queued",
    maxAttempts: integrationMaxAttempts(),
    ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
    progress: { request: input.request },
  })

  if (!created) {
    const stored = manualRequestFingerprint({
      meetingId: delivery.meetingId,
      provider: delivery.provider,
      connectionId: delivery.connectionId,
      request: delivery.progress.request as ManualRequest | undefined,
    })

    if (stored !== manualRequestFingerprint(input)) return { reuse: true }
  }

  if (created) {
    await queue.enqueue("integration.deliver", { workspaceId: input.workspaceId, deliveryId: delivery.id }, { jobId: deliverJobId(delivery.id) })
  }
  return { delivery, created }
}
