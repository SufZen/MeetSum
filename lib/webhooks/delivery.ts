import { UnrecoverableError } from "bullmq"

import { getDatabasePool } from "@/lib/db/client"
import { getMeetSumQueue } from "@/lib/jobs/queue"
import { WEBHOOK_EVENTS_V1, type WebhookPayloadVersion } from "@/lib/platform/event-catalog"
import {
  isWebhookEventV2,
  minimalPrivatePayload,
  resolveWebhookPayloadV2,
} from "@/lib/platform/event-payloads"
import {
  createPlatformEvent,
  signWebhookPayload,
  signWebhookPayloadV2,
  toPlatformEventV2,
  type PlatformEvent,
  type PlatformEventName,
} from "@/lib/platform/events"
import {
  getWebhookBackoffMs,
  getWebhookConcurrency,
  getWebhookFetchTimeoutMs,
  getWebhookInlineFallbackMax,
  getWebhookMaxAttempts,
  getWebhookMaxSubscriptionsPerEvent,
  getWebhookMaxTotalAttempts,
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
  /** 027: absent on rows read before the migration → 1. */
  payload_version?: number | null
}

type DeliveryJobRow = {
  id: string
  event_name: string
  event_payload: PlatformEvent<Record<string, unknown>> | string
  payload_version?: number | null
  status: string
  attempts?: number | null
  subscription_id: string | null
  url: string | null
  enabled: boolean | null
  secret_ciphertext: string | null
  subscription_workspace_id?: string | null
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

export const QUEUE_UNAVAILABLE_ERROR =
  "Webhook queue unavailable; retry this delivery from the dashboard"

/**
 * Fans an event out to enabled subscriptions (capped by
 * MEETSUM_WEBHOOK_MAX_SUBSCRIPTIONS_PER_EVENT): one queued `webhook_deliveries`
 * row per subscription, delivered by the worker through
 * `processWebhookDeliveryJob` with exponential-backoff retries.
 *
 * When the queue cannot be reached the work stays bounded: enqueueing is not
 * retried for the remaining subscriptions, at most
 * MEETSUM_WEBHOOK_INLINE_FALLBACK_MAX deliveries get one concurrent inline
 * attempt, and the rest are marked failed for a manual retry.
 *
 * Versioning (M8 C4): a subscription's `payload_version` picks the payload.
 * v1 subscriptions get today's envelope and data, byte-for-byte, and never
 * an event outside the v1 catalog. v2 subscriptions get the catalog envelope
 * `{id, name, version: 2, occurredAt, workspace_id, data}` with the v2 data
 * (`dataV2`, or rebuilt from `data` by re-reading the meeting; any failure
 * falls back to the minimal private payload).
 */
export async function deliverWebhookEvent(options: {
  eventName: PlatformEventName
  /** v1 data (already privacy-filtered by the caller). */
  data: Record<string, unknown>
  /** Pre-built v2 data; otherwise resolved from `data` when a v2 subscription matches. */
  dataV2?: Record<string, unknown>
  /**
   * Owning workspace. Only that workspace's subscriptions are considered
   * (`workspace_id = $1`), so a W1 event never reaches a W2 subscription; an
   * event without a workspace is dropped (fail closed).
   */
  workspaceId: string
}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    return { queued: 0, delivered: 0, failed: 0, skipped: true }
  }

  const workspaceId = options.workspaceId?.trim()

  if (!workspaceId) {
    console.warn(
      `[webhooks] ${options.eventName}: dropped, the event carries no workspace`
    )
    return { queued: 0, delivered: 0, failed: 0, skipped: true }
  }

  const pool = getDatabasePool()
  const event = createPlatformEvent(options.eventName, options.data, {
    workspaceId,
  })
  const maxAttempts = getWebhookMaxAttempts()
  const fanOutLimit = getWebhookMaxSubscriptionsPerEvent()
  const subscriptions = await pool.query(
    `
      select id, url, events, payload_version
      from webhook_subscriptions
      where enabled = true
        and workspace_id = $1
        and events ? $2
      order by created_at asc
      limit $3
    `,
    [workspaceId, options.eventName, fanOutLimit + 1]
  )
  const inV1 = (WEBHOOK_EVENTS_V1 as readonly string[]).includes(options.eventName)
  const matching = (subscriptions.rows as WebhookSubscriptionRow[]).filter(
    (subscription) =>
      parseEvents(subscription.events).includes(options.eventName) &&
      // A v1 subscription never receives an event outside the v1 catalog.
      (subscriptionVersion(subscription) === 2 || inV1)
  )
  let eventV2: ReturnType<typeof toPlatformEventV2> | undefined

  const payloadFor = async (version: WebhookPayloadVersion) => {
    if (version === 1) return event

    eventV2 ??= toPlatformEventV2(event, workspaceId, await v2DataFor(options, workspaceId))

    return eventV2
  }
  const truncated = matching.length > fanOutLimit

  if (truncated) {
    console.warn(
      `[webhooks] ${options.eventName}: fan-out capped at ${fanOutLimit} subscriptions`
    )
  }

  let queued = 0
  let queueAvailable = true
  const inlineCandidates: string[] = []
  const deferred: string[] = []
  const inlineMax = getWebhookInlineFallbackMax()

  for (const subscription of matching.slice(0, fanOutLimit)) {
    const deliveryId = createId("whdel")
    const version = subscriptionVersion(subscription)
    await pool.query(
      `
        insert into webhook_deliveries (
          id, webhook_subscription_id, event_name, status, attempts,
          max_attempts, event_payload, payload_version
        )
        values ($1, $2, $3, 'queued', 0, $4, $5::jsonb, $6)
      `,
      [
        deliveryId,
        subscription.id,
        options.eventName,
        maxAttempts,
        JSON.stringify(await payloadFor(version)),
        version,
      ]
    )

    if (queueAvailable) {
      try {
        await enqueueWebhookDelivery(deliveryId, maxAttempts)
        queued += 1
        continue
      } catch {
        // Don't pay the enqueue timeout again for every remaining subscription.
        queueAvailable = false
      }
    }

    if (inlineCandidates.length < inlineMax) inlineCandidates.push(deliveryId)
    else deferred.push(deliveryId)
  }

  for (const deliveryId of deferred) {
    await markDelivery(deliveryId, { status: "failed", lastError: QUEUE_UNAVAILABLE_ERROR })
  }

  // One final attempt each (no retries will follow), run concurrently so the
  // caller waits at most about one request timeout.
  const inlineResults = await Promise.allSettled(
    inlineCandidates.map((deliveryId) =>
      processWebhookDeliveryJob({ deliveryId, attempt: 1, maxAttempts: 1 })
    )
  )
  const delivered = inlineResults.filter(
    (result) => result.status === "fulfilled" && result.value.status === "sent"
  ).length

  return {
    queued,
    delivered,
    failed: inlineResults.length - delivered + deferred.length,
    truncated,
    eventId: event.id,
  }
}

/**
 * Headers of every webhook request (deliveries and test-fire):
 * - `x-meetsum-signature`: hex HMAC-SHA256 over the body (v1, kept for
 *   existing receivers);
 * - `x-meetsum-timestamp` + `x-meetsum-signature-v2: t=<unix>,v1=<hex
 *   HMAC-SHA256(secret, t + "." + body)>` (replay-safe; receivers reject a
 *   skew over 5 minutes), signed at send time so each retry is fresh;
 * - `x-meetsum-event`, `x-meetsum-delivery` (dedupe key), `x-meetsum-event-version`.
 */
export function webhookRequestHeaders(input: {
  body: string
  secret: string
  v1Signature: string
  eventName: string
  deliveryId: string
  version: WebhookPayloadVersion
  timestamp?: number
}): Record<string, string> {
  const v2 = signWebhookPayloadV2(input.body, input.secret, input.timestamp)

  return {
    "content-type": "application/json",
    "x-meetsum-signature": input.v1Signature,
    "x-meetsum-timestamp": String(v2.timestamp),
    "x-meetsum-signature-v2": v2.header,
    "x-meetsum-event": input.eventName,
    "x-meetsum-event-version": String(input.version),
    "x-meetsum-delivery": input.deliveryId,
  }
}

function subscriptionVersion(subscription: Pick<WebhookSubscriptionRow, "payload_version">): WebhookPayloadVersion {
  return Number(subscription.payload_version) === 2 ? 2 : 1
}

/** v2 data: given, or rebuilt from the v1 data; never throws (fails closed). */
async function v2DataFor(
  options: { eventName: PlatformEventName; data: Record<string, unknown>; dataV2?: Record<string, unknown> },
  workspaceId: string
): Promise<Record<string, unknown>> {
  if (options.dataV2) return options.dataV2
  if (!isWebhookEventV2(options.eventName)) return minimalPrivatePayload(workspaceId, options.data)

  try {
    return await resolveWebhookPayloadV2(options.eventName, options.data, { workspaceId })
  } catch {
    return minimalPrivatePayload(workspaceId, options.data)
  }
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

/**
 * In-process limiter for outgoing webhook requests: at most `global` in flight
 * per process and `perHost` per target host, so a burst of events (many
 * `webhook.deliver` jobs picked up at once) cannot flood one receiver. Waiters
 * are served FIFO. Each request is itself bounded by the fetch timeout.
 */
type Waiter = { host: string; run: () => void }
let activeTotal = 0
const activePerHost = new Map<string, number>()
const waiters: Waiter[] = []

function canStart(host: string) {
  const limits = getWebhookConcurrency()
  return (
    activeTotal < limits.global && (activePerHost.get(host) ?? 0) < limits.perHost
  )
}

function acquire(host: string) {
  activeTotal += 1
  activePerHost.set(host, (activePerHost.get(host) ?? 0) + 1)
}

function release(host: string) {
  activeTotal -= 1
  const remaining = (activePerHost.get(host) ?? 1) - 1
  if (remaining > 0) activePerHost.set(host, remaining)
  else activePerHost.delete(host)

  for (let index = 0; index < waiters.length; index += 1) {
    if (canStart(waiters[index].host)) {
      const [next] = waiters.splice(index, 1)
      acquire(next.host)
      next.run()
      break
    }
  }
}

async function withDeliverySlot<T>(host: string, task: () => Promise<T>): Promise<T> {
  if (canStart(host)) acquire(host)
  else await new Promise<void>((resolve) => waiters.push({ host, run: resolve }))

  try {
    return await task()
  } finally {
    release(host)
  }
}

function hostKey(url: string) {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return url
  }
}

/** Test hook: current limiter occupancy. */
export function getWebhookDeliverySlotStats() {
  return { active: activeTotal, waiting: waiters.length }
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
      select d.id, d.event_name, d.event_payload, d.payload_version, d.status, d.attempts,
             s.id as subscription_id, s.url, s.enabled, s.secret_ciphertext,
             s.workspace_id as subscription_workspace_id
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

  const event =
    typeof row.event_payload === "string"
      ? (JSON.parse(row.event_payload) as PlatformEvent<Record<string, unknown>>)
      : row.event_payload

  // Defence in depth: never send an event to another workspace's subscription,
  // even if a delivery row somehow points at one.
  if (
    event.workspace_id &&
    row.subscription_workspace_id &&
    event.workspace_id !== row.subscription_workspace_id
  ) {
    await markDelivery(deliveryId, {
      status: "cancelled",
      lastError: "Webhook subscription belongs to another workspace",
    })
    return { deliveryId, status: "cancelled" }
  }

  // Lifetime ceiling, independent of how many manual retries were requested.
  if ((row.attempts ?? 0) >= getWebhookMaxTotalAttempts()) {
    const message = "Webhook delivery exhausted its total attempt budget"
    await markDelivery(deliveryId, { status: "failed", lastError: message })
    throw new UnrecoverableError(message)
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

  let secret: string
  let signature: string
  try {
    secret = resolveSubscriptionSecret(row)
    signature = signWebhookPayload(event, secret)
  } catch (error) {
    await markDelivery(deliveryId, { status: "failed", lastError: errorMessage(error) })
    throw new UnrecoverableError(errorMessage(error))
  }

  const body = JSON.stringify(event)
  const version = Number(row.payload_version) === 2 || (event as { version?: unknown }).version === 2 ? 2 : 1

  let response: Awaited<ReturnType<typeof guardedWebhookFetch>>
  try {
    const url = row.url
    response = await withDeliverySlot(hostKey(url), () =>
      guardedWebhookFetch(url, {
        method: "POST",
        headers: webhookRequestHeaders({
          body,
          secret,
          v1Signature: signature,
          eventName: row.event_name,
          deliveryId,
          version,
        }),
        body,
        timeoutMs: getWebhookFetchTimeoutMs(),
      })
    )
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
