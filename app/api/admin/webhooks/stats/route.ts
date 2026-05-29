import { NextResponse } from "next/server"

import { requireAppAccess, jsonError } from "@/lib/api/responses"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import {
  listWebhookSubscriptions,
  listWebhookDeliveries,
} from "@/lib/webhooks/management"

/**
 * GET /api/admin/webhooks/stats — Webhook system health dashboard.
 */
export async function GET(request: Request) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  try {
    const [subscriptions, deliveries] = await Promise.all([
      listWebhookSubscriptions(),
      listWebhookDeliveries({ limit: 100 }),
    ])

    const activeSubscriptions = subscriptions.filter((s) => s.enabled)
    const disabledSubscriptions = subscriptions.filter((s) => !s.enabled)

    const now = Date.now()
    const last24h = deliveries.filter(
      (d) => now - new Date(d.createdAt).getTime() < 86400000
    )
    const last7d = deliveries.filter(
      (d) => now - new Date(d.createdAt).getTime() < 604800000
    )

    const successCount = last24h.filter((d) => d.status === "sent").length
    const failedCount = last24h.filter((d) => d.status === "failed").length
    const pendingCount = last24h.filter(
      (d) => d.status === "pending" || d.status === "active"
    ).length

    const eventBreakdown = new Map<string, number>()

    for (const delivery of last7d) {
      eventBreakdown.set(
        delivery.eventName,
        (eventBreakdown.get(delivery.eventName) ?? 0) + 1
      )
    }

    const recentFailures = deliveries
      .filter((d) => d.status === "failed")
      .slice(0, 5)
      .map((d) => ({
        id: d.id,
        subscriptionUrl: d.subscriptionUrl,
        eventName: d.eventName,
        lastError: d.lastError,
        attempts: d.attempts,
        createdAt: d.createdAt,
      }))

    return NextResponse.json(
      {
        subscriptions: {
          total: subscriptions.length,
          active: activeSubscriptions.length,
          disabled: disabledSubscriptions.length,
        },
        deliveries: {
          last24h: {
            total: last24h.length,
            sent: successCount,
            failed: failedCount,
            pending: pendingCount,
            successRate:
              last24h.length > 0
                ? Math.round((successCount / last24h.length) * 100)
                : 100,
          },
          last7d: {
            total: last7d.length,
            eventBreakdown: Object.fromEntries(eventBreakdown),
          },
        },
        recentFailures,
      },
      { headers: rateLimit.headers }
    )
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Failed to gather webhook stats",
      500
    )
  }
}
