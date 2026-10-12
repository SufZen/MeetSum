import { UnrecoverableError } from "bullmq"

import { getDatabasePool } from "@/lib/db/client"
import { getMeetSumQueue } from "@/lib/jobs/queue"
import {
  createPlatformEvent,
  signWebhookPayload,
  type PlatformEvent,
  type PlatformEventName,
} from "@/lib/platform/events"
import {
  getWebhookBackoffMs,
  getWebhookFetchTimeoutMs,
  getWebhookMaxAttempts,
  resolveSubscriptionSecret,
} from "@/lib/webhooks/secret"
import {
  guardedWebhookFetch,
  UnsafeWebhookUrlError,
} from "@/lib/webhooks/url-guard"

type WebhookSubscriptionRow = {
  id: string
  url: string
  events: string[] | string
}

type DeliveryJobRow = {
  id: string
  event_name: string
  event_payload: PlatformEvent<Record<string, unknown>> | string
  status: string
  subscription_id: string | null
  url: string | null
  enabled: boolean | null
  secret_ciphertext: string | null
}

export type WebhookDeliveryJobResult = {
  deliveryId: string
  status: string
  responseStatus?: number
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

function parseEvents(events: string[] | string): string[] {
  if (Array.isArray(events)) return events

  try {
    const parsed = JSON.parse(events) as unknown
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Webhook delivery failed"
}

/**
 * Enqueues one `webhook.deliver` BullMQ job for a queued delivery row. The
 * delivery id doubles as the job id so the same row is never queued twice
 * concurrently. Throws when the queue is unavailable.
 */
export async function enqueueWebhookDelivery(
  deliveryId: string,
  maxAttempts: number,
  env: NodeJS.ProcessEnv = process.env
) {
  // ioredis queues commands while Redis is unreachable; bound the wait so the
  // caller can fall back to an inline attempt instead of hanging.
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Timed out enqueueing webhook delivery")),
      ENQUEUE_TIMEOUT_MS
    )
  })

  try {
    await Promise.race([addDeliveryJob(deliveryId, maxAttempts, env), timeout])
  } finally {
    clearTimeout(timer)
  }
}

const ENQUEUE_TIMEOUT_MS = 5_000

async function addDeliveryJob(
  deliveryId: string,
  maxAttempts: number,
  env: NodeJS.ProcessEnv
) {
  const queue = getMeetSumQueue()
  // A finished job with the same id would make `add` a silent no-op; remove it
  // first so manual retries of a failed/cancelled delivery are picked up.
  const existing = await queue.getJob(deliveryId)
  if (existing) {
    const state = await existing.getState()
    if (state === "completed" || state === "failed") {
      await existing.remove()
    }
  }

  await queue.add(
    "webhook.deliver",
    { deliveryId },
    {
      jobId: deliveryId,
      attempts: maxAttempts,
      backoff: { type: "exponential", delay: getWebhookBackoffMs(env) },
      removeOnComplete: 250,
      removeOnFail: 500,
    }
  )
}

/**
 * Fans an event out to every enabled subscription: one queued
 * `webhook_deliveries` row per subscription, delivered by the worker through
 * `processWebhookDeliveryJob` with exponential-backoff retries. When the queue
 * cannot be reached, a single inline attempt is made instead.
 */
export async function deliverWebhookEvent(options: {
  eventName: PlatformEventName
  data: Record<string, unknown>
}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    return { queued: 0, delivered: 0, failed: 0, skipped: true }
  }

  const pool = getDatabasePool()
  const event = createPlatformEvent(options.eventName, options.data)
  const maxAttempts = getWebhookMaxAttempts()
  const subscriptions = await pool.query(
    `
      select id, url, events
      from webhook_subscriptions
      where enabled = true
    `
  )
  let queued = 0
  let delivered = 0
  let failed = 0

  for (const subscription of subscriptions.rows as WebhookSubscriptionRow[]) {
    if (!parseEvents(subscription.events).includes(options.eventName)) continue

    const deliveryId = createId("whdel")
    await pool.query(
      `
        insert into webhook_deliveries (
          id, webhook_subscription_id, event_name, status, attempts,
          max_attempts, event_payload
        )
        values ($1, $2, $3, 'queued', 0, $4, $5::jsonb)
      `,
      [
        deliveryId,
        subscription.id,
        options.eventName,
        maxAttempts,
        JSON.stringify(event),
      ]
    )

    try {
      await enqueueWebhookDelivery(deliveryId, maxAttempts)
      queued += 1
    } catch {
      // Queue unavailable: make exactly one inline attempt so the event is not
      // silently dropped. No retries will follow, so treat it as final.
      try {
        const result = await processWebhookDeliveryJob({
          deliveryId,
          attempt: 1,
          maxAttempts: 1,
        })
        if (result.status === "sent") delivered += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
  }

  return { queued, delivered, failed, eventId: event.id }
}

async function markDelivery(
  deliveryId: string,
  patch: {
    status: string
    responseStatus?: number | null
    lastError?: string | null
    durationMs?: number | null
    delivered?: boolean
  }
) {
  await getDatabasePool().query(
    `
      update webhook_deliveries
      set status = $2,
          response_status = coalesce($3, response_status),
          last_error = $4,
          duration_ms = coalesce($5, duration_ms),
          delivered_at = case when $6 then now() else delivered_at end,
          updated_at = now()
      where id = $1
    `,
    [
      deliveryId,
      patch.status,
      patch.responseStatus ?? null,
      patch.lastError ?? null,
      patch.durationMs ?? null,
      patch.delivered === true,
    ]
  )
}

/** True for 4xx responses that will not succeed on retry (408 and 429 are retryable). */
function isPermanentClientError(status: number) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

/**
 * Delivers one queued `webhook_deliveries` row. Called by the worker for the
 * `webhook.deliver` job (attempt = attemptsMade + 1).
 *
 * - subscription missing/disabled → `cancelled`
 * - 2xx → `sent`
 * - unsafe URL, undecryptable secret, or a non-retryable 4xx → `failed` and an
 *   `UnrecoverableError` so BullMQ stops retrying
 * - anything else → `retrying` (or `failed` on the last attempt) and a thrown
 *   error so BullMQ schedules the next backoff
 */
export async function processWebhookDeliveryJob(input: {
  deliveryId: string
  attempt: number
  maxAttempts: number
}): Promise<WebhookDeliveryJobResult> {
  const { deliveryId, attempt, maxAttempts } = input
  const pool = getDatabasePool()
  const result = await pool.query(
    `
      select d.id, d.event_name, d.event_payload, d.status,
             s.id as subscription_id, s.url, s.enabled, s.secret_ciphertext
      from webhook_deliveries d
      left join webhook_subscriptions s on s.id = d.webhook_subscription_id
      where d.id = $1
      limit 1
    `,
    [deliveryId]
  )
  const row = result.rows[0] as DeliveryJobRow | undefined

  if (!row) return { deliveryId, status: "cancelled" }
  if (row.status === "sent" || row.status === "cancelled") {
    return { deliveryId, status: row.status }
  }

  if (!row.subscription_id || !row.url || row.enabled === false) {
    await markDelivery(deliveryId, {
      status: "cancelled",
      lastError: row.subscription_id
        ? "Webhook subscription is disabled"
        : "Webhook subscription no longer exists",
    })
    return { deliveryId, status: "cancelled" }
  }

  await pool.query(
    `
      update webhook_deliveries
      set status = 'active',
          attempts = attempts + 1,
          updated_at = now()
      where id = $1
    `,
    [deliveryId]
  )

  const event =
    typeof row.event_payload === "string"
      ? (JSON.parse(row.event_payload) as PlatformEvent<Record<string, unknown>>)
      : row.event_payload

  let signature: string
  try {
    signature = signWebhookPayload(event, resolveSubscriptionSecret(row))
  } catch (error) {
    await markDelivery(deliveryId, { status: "failed", lastError: errorMessage(error) })
    throw new UnrecoverableError(errorMessage(error))
  }

  let response: Awaited<ReturnType<typeof guardedWebhookFetch>>
  try {
    response = await guardedWebhookFetch(row.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-meetsum-signature": signature,
        "x-meetsum-event": row.event_name,
        "x-meetsum-delivery": deliveryId,
      },
      body: JSON.stringify(event),
      timeoutMs: getWebhookFetchTimeoutMs(),
    })
  } catch (error) {
    if (error instanceof UnsafeWebhookUrlError) {
      await markDelivery(deliveryId, { status: "failed", lastError: error.message })
      throw new UnrecoverableError(error.message)
    }

    const isFinal = attempt >= maxAttempts
    await markDelivery(deliveryId, {
      status: isFinal ? "failed" : "retrying",
      lastError: errorMessage(error),
    })
    throw error instanceof Error ? error : new Error(errorMessage(error))
  }

  if (response.ok) {
    await markDelivery(deliveryId, {
      status: "sent",
      responseStatus: response.status,
      durationMs: response.durationMs,
      delivered: true,
    })
    return { deliveryId, status: "sent", responseStatus: response.status }
  }

  const message = `Webhook receiver responded with HTTP ${response.status}`

  if (isPermanentClientError(response.status)) {
    await markDelivery(deliveryId, {
      status: "failed",
      responseStatus: response.status,
      durationMs: response.durationMs,
      lastError: message,
    })
    throw new UnrecoverableError(message)
  }

  const isFinal = attempt >= maxAttempts
  await markDelivery(deliveryId, {
    status: isFinal ? "failed" : "retrying",
    responseStatus: response.status,
    durationMs: response.durationMs,
    lastError: message,
  })
  throw new Error(message)
}
