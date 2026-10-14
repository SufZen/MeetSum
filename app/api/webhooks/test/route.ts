import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import {
  isWebhookEventName,
  sendWebhookTest,
  WebhookNotFoundError,
  WebhookValidationError,
} from "@/lib/webhooks/management"

/**
 * POST /api/webhooks/test `{subscriptionId | url, eventName?, payloadVersion?}`
 * (M8 C4): sends the catalog example payload of `eventName` (schema-valid,
 * flagged `test: true`) in the subscription's payload version, with the
 * production headers and both signatures.
 */
export const POST = withAuthz("webhooks:manage", async (request, ctx) => {
  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.webhookTest)

  if (rateLimit.blocked) return rateLimit.blocked

  const body = (await request.json().catch(() => ({}))) as {
    url?: string
    subscriptionId?: string
    eventName?: unknown
    payloadVersion?: unknown
  }

  if (body.eventName !== undefined && !isWebhookEventName(body.eventName)) {
    return NextResponse.json(
      { error: "unknown_event", message: "Unknown webhook event" },
      { status: 400 }
    )
  }

  try {
    const result = await sendWebhookTest(ctx.workspace.id, {
      url: body.url,
      subscriptionId: body.subscriptionId,
      eventName: body.eventName,
      payloadVersion: body.payloadVersion,
    })
    await recordAuditLog({
      ...ctx.audit,
      action: "webhook.test.sent",
      targetType: body.subscriptionId ? "webhook_subscription" : "webhook_url",
      targetId: body.subscriptionId,
      metadata: {
        url: result.url,
        eventName: result.event.name,
        payloadVersion: result.payloadVersion,
        status: result.status,
        responseStatus: result.responseStatus,
      },
    })

    return NextResponse.json(result, {
      status: result.status === "sent" ? 200 : 502,
      headers: { "cache-control": "no-store", ...rateLimit.headers },
    })
  } catch (error) {
    if (error instanceof WebhookValidationError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 400 })
    }

    return jsonError(
      error instanceof Error ? error.message : "Unable to send webhook test",
      error instanceof WebhookNotFoundError ? 404 : 400
    )
  }
})
