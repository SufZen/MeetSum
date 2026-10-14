import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import {
  deleteWebhookSubscription,
  updateWebhookSubscription,
  WebhookNotFoundError,
  WebhookValidationError,
} from "@/lib/webhooks/management"

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof WebhookValidationError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 400 })
  }

  return jsonError(
    error instanceof Error ? error.message : fallback,
    error instanceof WebhookNotFoundError ? 404 : 400
  )
}

export const PATCH = withAuthz<{ id: string }>(
  "webhooks:manage",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as {
      url?: unknown
      enabled?: unknown
      events?: unknown
      rotateSecret?: unknown
      /** `2` upgrades a v1 subscription to the catalog payloads (one-way). */
      payloadVersion?: unknown
    }

    try {
      const { subscription, secret } = await updateWebhookSubscription(
        ctx.workspace.id,
        id,
        body
      )
      await recordAuditLog({
        ...ctx.audit,
        action: "webhook.subscription.updated",
        targetType: "webhook_subscription",
        targetId: id,
        metadata: {
          url: subscription.url,
          enabled: subscription.enabled,
          events: subscription.events,
          payloadVersion: subscription.payloadVersion,
          secretRotated: Boolean(secret),
        },
      })

      return NextResponse.json(
        secret ? { subscription, secret } : { subscription },
        { headers: { "cache-control": "no-store" } }
      )
    } catch (error) {
      return errorResponse(error, "Unable to update webhook subscription")
    }
  }
)

export const DELETE = withAuthz<{ id: string }>(
  "webhooks:manage",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params

    try {
      const result = await deleteWebhookSubscription(ctx.workspace.id, id)
      await recordAuditLog({
        ...ctx.audit,
        // lib/audit.ts has no dedicated delete action; record it as an update.
        action: "webhook.subscription.updated",
        targetType: "webhook_subscription",
        targetId: id,
        metadata: { deleted: true },
      })

      return NextResponse.json(result)
    } catch (error) {
      return errorResponse(error, "Unable to delete webhook subscription")
    }
  }
)
