import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { updateWebhookSubscription } from "@/lib/webhooks/management"

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const body = (await request.json()) as {
    enabled?: boolean
    events?: unknown
  }

  try {
    const subscription = await updateWebhookSubscription(id, body)

    return NextResponse.json({ subscription })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to update webhook subscription",
      404
    )
  }
}
