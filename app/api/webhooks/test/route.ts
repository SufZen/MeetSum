import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import {
  sendWebhookTest,
  WEBHOOK_EVENT_NAMES,
  type WebhookEventName,
} from "@/lib/webhooks/management"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const body = (await request.json().catch(() => ({}))) as {
    url?: string
    subscriptionId?: string
    eventName?: string
  }
  const eventName = WEBHOOK_EVENT_NAMES.includes(body.eventName as WebhookEventName)
    ? (body.eventName as WebhookEventName)
    : undefined

  try {
    const result = await sendWebhookTest({
      url: body.url,
      subscriptionId: body.subscriptionId,
      eventName,
    })
    await recordAuditLog({
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
      400
    )
  }
}
