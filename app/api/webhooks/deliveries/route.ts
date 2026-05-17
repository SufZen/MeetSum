import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { listWebhookDeliveries } from "@/lib/webhooks/management"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const url = new URL(request.url)
  const subscriptionId = url.searchParams.get("subscriptionId") ?? undefined
  const limit = Number(url.searchParams.get("limit") ?? 25)
  const deliveries = await listWebhookDeliveries({ subscriptionId, limit })

  return NextResponse.json({ deliveries })
}
