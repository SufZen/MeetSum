import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import {
  createWebhookSubscription,
  createWebhookTestSignature,
  listWebhookSubscriptions,
  WebhookValidationError,
} from "@/lib/webhooks/management"

export const GET = withAuthz("webhooks:manage", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const subscriptions = await listWebhookSubscriptions(ctx.workspace.id)

  return NextResponse.json({ subscriptions }, { headers: rateLimit.headers })
})

export const POST = withAuthz("webhooks:manage", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const { url, events, secret, payloadVersion } = (await request.json().catch(() => ({}))) as {
    url?: string
    events?: unknown
    secret?: unknown
    /** 1 or 2; new subscriptions default to 2 (the event catalog). */
    payloadVersion?: unknown
  }

  if (!url) {
    return jsonError("Webhook URL is required", 400)
  }

  try {
    const created = await createWebhookSubscription(ctx.workspace.id, {
      url,
      events,
      secret,
      payloadVersion,
    })
    const { subscription } = created
    const { event, signature } = createWebhookTestSignature(
      subscription.url,
      created.secret,
      ctx.workspace.id
    )
    await recordAuditLog({
      ...ctx.audit,
      action: "webhook.subscription.created",
      targetType: "webhook_subscription",
      targetId: subscription.id,
      metadata: {
        url: subscription.url,
        events: subscription.events,
        payloadVersion: subscription.payloadVersion,
        secretRef: subscription.secretRef,
      },
    })

    return NextResponse.json(
      {
        subscription,
        // Shown once: the plaintext secret is never returned again.
        secret: created.secret,
        testEvent: event,
        signature,
      },
      { status: 201, headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    if (error instanceof WebhookValidationError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 400 })
    }

    return jsonError(
      error instanceof Error ? error.message : "Unable to create webhook subscription",
      400
    )
  }
})
