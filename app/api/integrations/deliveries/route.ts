import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { apiError } from "@/lib/integrations/core/api"
import { isDeliveryStatus, toVisibleDeliveryDTOs } from "@/lib/integrations/core/deliveries"
import { getIntegrationStore } from "@/lib/integrations/core/store"

/**
 * GET /api/integrations/deliveries?status&provider&ruleId&meetingId&before&limit
 * (M8 A7) → `{deliveries, nextCursor}`. Workspace-scoped; `meetingTitle`
 * only when the viewer can see the meeting (else null).
 */
export const GET = withAuthz("integrations:manage", async (request, ctx) => {
  const params = new URL(request.url).searchParams
  const status = params.get("status")

  if (status && !isDeliveryStatus(status)) return apiError("invalid_status", 400)

  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 200)
  const store = await getIntegrationStore()
  const rows = await store.listDeliveries(ctx.workspace.id, {
    ...(status && isDeliveryStatus(status) ? { status } : {}),
    ...(params.get("provider") ? { provider: params.get("provider")!.slice(0, 32) } : {}),
    ...(params.get("ruleId") ? { ruleId: params.get("ruleId")!.slice(0, 200) } : {}),
    ...(params.get("meetingId") ? { meetingId: params.get("meetingId")!.slice(0, 200) } : {}),
    ...(params.get("before") ? { before: params.get("before")!.slice(0, 300) } : {}),
    limit,
  })
  const last = rows.at(-1)

  return NextResponse.json({
    deliveries: await toVisibleDeliveryDTOs(rows, ctx.meetings),
    ...(rows.length === limit && last ? { nextCursor: `${last.createdAt}|${last.id}` } : {}),
  })
})
