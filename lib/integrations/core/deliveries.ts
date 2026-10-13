/**
 * Delivery log service (docs/parity/m8.md A6/A7). Owner: Package A.
 * `meetingTitle` is shown only when the meeting is visible to the viewer
 * (otherwise `null` → "Private meeting"). Retry is allowed for `failed`,
 * `partial`, or `skipped/needs_reauth`; it resets attempts and keeps the
 * idempotency key.
 */
import { randomUUID } from "node:crypto"

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

/** Inserts (or replays) a manual delivery; enqueues only a new row. */
export async function createManualDelivery(
  store: IntegrationStore,
  queue: IntegrationQueuePort,
  input: ManualSendInput
): Promise<{ delivery: StoredDelivery; created: boolean }> {
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

  if (created) {
    await queue.enqueue("integration.deliver", { workspaceId: input.workspaceId, deliveryId: delivery.id }, { jobId: deliverJobId(delivery.id) })
  }
  return { delivery, created }
}
