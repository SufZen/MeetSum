import { getDatabasePool } from "@/lib/db/client"
import {
  createPlatformEvent,
  signWebhookPayload,
  type PlatformEventName,
} from "@/lib/platform/events"

type WebhookSubscriptionRow = {
  id: string
  url: string
  events: string[]
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

export async function deliverWebhookEvent(options: {
  eventName: PlatformEventName
  data: Record<string, unknown>
}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    return { delivered: 0, skipped: true }
  }

  const pool = getDatabasePool()
  const event = createPlatformEvent(options.eventName, options.data)
  const subscriptions = await pool.query(
    `
      select id, url, events
      from webhook_subscriptions
      where enabled = true
    `
  )
  let delivered = 0
  let failed = 0

  for (const subscription of subscriptions.rows as WebhookSubscriptionRow[]) {
    if (!subscription.events.includes(options.eventName)) continue

    const deliveryId = createId("whdel")
    await pool.query(
      `
        insert into webhook_deliveries (
          id, webhook_subscription_id, event_name, status, attempts, event_payload
        )
        values ($1, $2, $3, 'active', 1, $4::jsonb)
      `,
      [
        deliveryId,
        subscription.id,
        options.eventName,
        JSON.stringify(event),
      ]
    )

    try {
      const response = await fetch(subscription.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-meetsum-signature": signWebhookPayload(
            event,
            process.env.WEBHOOK_SIGNING_SECRET ?? "dev-secret"
          ),
        },
        body: JSON.stringify(event),
      })

      await pool.query(
        `
          update webhook_deliveries
          set status = $2,
              response_status = $3,
              updated_at = now()
          where id = $1
        `,
        [deliveryId, response.ok ? "sent" : "failed", response.status]
      )

      if (response.ok) delivered += 1
      else failed += 1
    } catch (error) {
      failed += 1
      await pool.query(
        `
          update webhook_deliveries
          set status = 'failed',
              last_error = $2,
              updated_at = now()
          where id = $1
        `,
        [
          deliveryId,
          error instanceof Error ? error.message : "Webhook delivery failed",
        ]
      )
    }
  }

  return { delivered, failed, eventId: event.id }
}
