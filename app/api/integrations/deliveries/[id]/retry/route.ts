import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { apiError, auditActor, limitFor } from "@/lib/integrations/core/api"
import { canRetry, retryDelivery, toVisibleDeliveryDTOs } from "@/lib/integrations/core/deliveries"
import { getIntegrationQueuePort } from "@/lib/integrations/core/queue"
import { getIntegrationStore } from "@/lib/integrations/core/store"

/**
 * POST /api/integrations/deliveries/[id]/retry (M8 A7). Allowed for
 * `failed`, `partial`, or `skipped` with reason `needs_reauth`; resets the
 * attempts and keeps the idempotency key.
 */
export const POST = withAuthz<{ id: string }>("integrations:manage", async (request, ctx, route) => {
  const limited = limitFor(request, ctx, "integrationsWrite")

  if (limited) return limited

  const { id } = await route.params
  const store = await getIntegrationStore()
  const row = await store.getDelivery(ctx.workspace.id, id)

  if (!row) return apiError("not_found", 404)
  if (!canRetry(row)) return apiError("not_retryable", 409)

  const updated = await retryDelivery(store, getIntegrationQueuePort(), row, auditActor(ctx))

  if (!updated) return apiError("not_found", 404)

  const latest = (await store.getDelivery(ctx.workspace.id, id)) ?? updated
  const [delivery] = await toVisibleDeliveryDTOs([latest], ctx.meetings)

  return NextResponse.json({ delivery }, { status: 202 })
})
