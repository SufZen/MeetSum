import { NextResponse } from "next/server"

import { createPlatformEvent, signWebhookPayload } from "@/lib/platform/events"

export async function POST(request: Request) {
  const { url, secret = "dev-secret" } = (await request.json()) as {
    url?: string
    secret?: string
  }

  if (!url) {
    return NextResponse.json({ error: "Webhook URL is required" }, { status: 400 })
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
    { status: 201 },
  )
}
