import { NextResponse } from "next/server"

import { jsonError, requireApiKey } from "@/lib/api/responses"
import { createApiKeyHash } from "@/lib/auth/api-keys"
import { getDatabasePool } from "@/lib/db/client"
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
  const subscription = {
    id: `wh_${crypto.randomUUID()}`,
    url,
    events: ["meeting.completed", "summary.created", "action_item.created"],
  }

  if (process.env.MEETSUM_STORAGE === "postgres") {
    await getDatabasePool().query(
      `
        insert into webhook_subscriptions (id, url, events, secret_ref, secret_hash, enabled)
        values ($1, $2, $3::jsonb, $4, $5, true)
      `,
      [
        subscription.id,
        subscription.url,
        JSON.stringify(subscription.events),
        secret ? "provided" : null,
        secret ? createApiKeyHash(secret) : null,
      ]
    )
  }

  return NextResponse.json(
    {
      subscription,
      testEvent: event,
      signature: signWebhookPayload(event, secret),
    },
    { status: 201 }
  )
}
