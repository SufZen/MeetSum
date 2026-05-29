import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import {
  createWebhookSubscription,
  createWebhookTestSignature,
  listWebhookSubscriptions,
} from "@/lib/webhooks/management"

export async function GET(request: Request) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const subscriptions = await listWebhookSubscriptions()

  return NextResponse.json({ subscriptions }, { headers: rateLimit.headers })
}

export async function POST(request: Request) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { url, events, secret } = (await request.json()) as {
    url?: string
    events?: unknown
    secret?: string
  }

  if (!url) {
    return jsonError("Webhook URL is required", 400)
  }

  try {
    const subscription = await createWebhookSubscription({ url, events, secret })
    const { event, signature } = createWebhookTestSignature(subscription.url)
    await recordAuditLog({
      action: "webhook.subscription.created",
      targetType: "webhook_subscription",
      targetId: subscription.id,
      metadata: { url: subscription.url, events: subscription.events },
    })

    return NextResponse.json(
      {
        subscription,
        testEvent: event,
        signature,
      },
      { status: 201 }
    )
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to create webhook subscription",
      400
    )
  }
}
