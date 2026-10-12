import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import {
  retryWebhookDelivery,
  WebhookNotFoundError,
} from "@/lib/webhooks/management"

const WEBHOOK_RETRY_LIMIT = { maxRequests: 3, windowMs: 60_000 }

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  // Per-delivery throttle on top of the admin preset.
  const perDelivery = rateLimitRequest(
    request,
    WEBHOOK_RETRY_LIMIT,
    `webhook-retry:${id}`
  )

  if (perDelivery.blocked) return perDelivery.blocked

  try {
    const delivery = await retryWebhookDelivery(id)
    await recordAuditLog({
      action: "webhook.delivery.retried",
      targetType: "webhook_delivery",
      targetId: id,
      metadata: {
        status: delivery.status,
        responseStatus: delivery.responseStatus,
        subscriptionId: delivery.subscriptionId,
      },
    })

    return NextResponse.json({ delivery })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to retry webhook delivery",
      error instanceof WebhookNotFoundError ? 404 : 400
    )
  }
}
