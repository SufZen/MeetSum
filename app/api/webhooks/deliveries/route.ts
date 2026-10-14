import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { listWebhookDeliveries } from "@/lib/webhooks/management"

export const GET = withAuthz("webhooks:manage", async (request, ctx) => {
  // M10 (D's API audit): the same `admin` preset as the other webhook routes.
  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const url = new URL(request.url)
  const subscriptionId = url.searchParams.get("subscriptionId") ?? undefined
  const limit = Number(url.searchParams.get("limit") ?? 25)
  const deliveries = await listWebhookDeliveries(ctx.workspace.id, {
    subscriptionId,
    limit: Number.isFinite(limit) ? limit : 25,
  })

  return NextResponse.json({ deliveries })
})
