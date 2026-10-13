import { NextResponse } from "next/server"

import { can, withAuthz } from "@/lib/auth/authz"
import { actorUserId, apiError } from "@/lib/integrations/core/api"
import { toVisibleDeliveryDTOs } from "@/lib/integrations/core/deliveries"
import { getIntegrationStore } from "@/lib/integrations/core/store"

/**
 * GET /api/integrations/deliveries/[id] (M8 A6). Admins, or the requester
 * of a manual delivery (used to poll a manual send). Anything else is 404.
 */
export const GET = withAuthz<{ id: string }>("meeting:write", async (_request, ctx, route) => {
  const { id } = await route.params
  const store = await getIntegrationStore()
  const row = await store.getDelivery(ctx.workspace.id, id)
  const me = actorUserId(ctx)

  if (!row) return apiError("not_found", 404)
  if (!can(ctx.role, "integrations:manage") && !(row.origin === "manual" && me && row.requestedByUserId === me)) {
    return apiError("not_found", 404)
  }

  const [delivery] = await toVisibleDeliveryDTOs([row], ctx.meetings)

  return NextResponse.json({ delivery })
})
