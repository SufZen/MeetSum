import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { retryWebhookDelivery } from "@/lib/webhooks/management"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params

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
      400
    )
  }
}
