import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { createPlatformEvent, signWebhookPayload } from "@/lib/platform/events"

export async function POST(request: Request) {
  const unauthorized = requireApiKey(request)

  if (unauthorized) {
    return unauthorized
  }

  const { url, secret = "dev-secret" } = (await request.json()) as {
    url?: string
    secret?: string
  }

  if (!url) {
    return jsonError("Webhook URL is required", 400)
  }

  const event = createPlatformEvent("summary.created", { url })

  return NextResponse.json(
    {
      subscription: {
        id: `wh_${crypto.randomUUID()}`,
        url,
        events: ["meeting.completed", "summary.created", "action_item.created"],
      },
      testEvent: event,
      signature: signWebhookPayload(event, secret),
    },
    { status: 201 }
  )
}
