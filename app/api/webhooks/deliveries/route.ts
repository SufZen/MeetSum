import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { listWebhookDeliveries } from "@/lib/webhooks/management"

export const GET = withAuthz("webhooks:manage", async (request, ctx) => {
  const url = new URL(request.url)
  const subscriptionId = url.searchParams.get("subscriptionId") ?? undefined
  const limit = Number(url.searchParams.get("limit") ?? 25)
  const deliveries = await listWebhookDeliveries(ctx.workspace.id, {
    subscriptionId,
    limit,
  })

  return NextResponse.json({ deliveries })
})
