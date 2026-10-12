import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import {
  sendWebhookTest,
  WEBHOOK_EVENT_NAMES,
  WebhookNotFoundError,
  type WebhookEventName,
} from "@/lib/webhooks/management"

export const POST = withAuthz("webhooks:manage", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const body = (await request.json().catch(() => ({}))) as {
    url?: string
    subscriptionId?: string
    eventName?: string
  }
  const eventName = WEBHOOK_EVENT_NAMES.includes(body.eventName as WebhookEventName)
    ? (body.eventName as WebhookEventName)
    : undefined

  try {
    const result = await sendWebhookTest(ctx.workspace.id, {
      url: body.url,
      subscriptionId: body.subscriptionId,
      eventName,
    })
    await recordAuditLog({
      ...ctx.audit,
      action: "webhook.test.sent",
      targetType: body.subscriptionId ? "webhook_subscription" : "webhook_url",
      targetId: body.subscriptionId,
      metadata: {
        url: result.url,
        eventName: result.event.name,
        status: result.status,
        responseStatus: result.responseStatus,
      },
    })

    return NextResponse.json(result, { status: result.status === "sent" ? 200 : 502 })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to send webhook test",
      error instanceof WebhookNotFoundError ? 404 : 400
    )
  }
})
