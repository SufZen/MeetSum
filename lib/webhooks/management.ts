import { createApiKeyHash } from "@/lib/auth/api-keys"
import { getDatabasePool } from "@/lib/db/client"
import {
  createPlatformEvent,
  signWebhookPayload,
  type PlatformEventName,
} from "@/lib/platform/events"
import {
  enqueueWebhookDelivery,
  processWebhookDeliveryJob,
} from "@/lib/webhooks/delivery"
import {
  encryptWebhookSecret,
  generateWebhookSecret,
  getWebhookFetchTimeoutMs,
  getWebhookMaxAttempts,
  getWebhookSigningSecret,
  MIN_WEBHOOK_SECRET_LENGTH,
  resolveSubscriptionSecret,
} from "@/lib/webhooks/secret"
import {
  assertSafeWebhookUrl,
  guardedWebhookFetch,
} from "@/lib/webhooks/url-guard"

export const WEBHOOK_EVENT_NAMES = [
  "meeting.completed",
  "summary.created",
  "action_item.created",
  "meeting.process_failed",
  "realizeos.export.sent",
  "realizeos.export.failed",
] as const satisfies readonly PlatformEventName[]

export type WebhookEventName = (typeof WEBHOOK_EVENT_NAMES)[number]

export type WebhookSubscriptionView = {
  id: string
  url: string
  events: WebhookEventName[]
  enabled: boolean
  /** "generated" | "provided" for per-subscription secrets, "global" for legacy rows. */
  secretRef?: string
  createdAt: string
  updatedAt?: string
}

export type WebhookDeliveryView = {
  id: string
  subscriptionId: string
  subscriptionUrl: string
  eventName: string
  status: string
  attempts: number
  maxAttempts?: number
  responseStatus?: number
  lastError?: string
  deliveredAt?: string
  durationMs?: number
  createdAt: string
  updatedAt?: string
}

/** A subscription plus its signing secret, returned only on create/rotate. */
export type WebhookSubscriptionWithSecret = {
  subscription: WebhookSubscriptionView
  secret?: string
}

/** Raised for unknown subscription/delivery ids so routes can answer 404. */
export class WebhookNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WebhookNotFoundError"
  }
}

type SubscriptionRow = {
  id: string
  url: string
  events: string[] | string
  enabled: boolean
  secret_ref: string | null
  created_at: string | Date
  updated_at?: string | Date | null
}

type DeliveryRow = {
  id: string
  webhook_subscription_id: string
  subscription_url: string
  event_name: string
  status: string
  attempts: number
  max_attempts?: number | null
  response_status: number | null
  last_error: string | null
  delivered_at?: string | Date | null
  duration_ms?: number | null
  created_at: string | Date
  updated_at?: string | Date | null
}

const SUBSCRIPTION_COLUMNS =
  "id, url, events, enabled, secret_ref, created_at, updated_at"
const DELIVERY_COLUMNS = `d.id, d.webhook_subscription_id, s.url as subscription_url,
             d.event_name, d.status, d.attempts, d.max_attempts,
             d.response_status, d.last_error, d.delivered_at, d.duration_ms,
             d.created_at, d.updated_at`

const memorySubscriptions = new Map<string, WebhookSubscriptionView>()
const memorySecrets = new Map<string, string>()
const memoryDeliveries = new Map<string, WebhookDeliveryView>()

function isPostgres() {
  return process.env.MEETSUM_STORAGE === "postgres"
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

function toIso(value: string | Date | null | undefined) {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function normalizeEvents(events?: unknown): WebhookEventName[] {
  if (!Array.isArray(events)) return [...WEBHOOK_EVENT_NAMES]

  const normalized = events.filter((event): event is WebhookEventName =>
    WEBHOOK_EVENT_NAMES.includes(event as WebhookEventName)
  )

  return normalized.length ? [...new Set(normalized)] : [...WEBHOOK_EVENT_NAMES]
}

function parseEvents(events: string[] | string): WebhookEventName[] {
  const parsed = typeof events === "string" ? JSON.parse(events) : events
  return normalizeEvents(parsed)
}

/** Resolves the signing secret for a new subscription (given ≥16 chars, or generated). */
function resolveNewSecret(secret: unknown): { secret: string; ref: string } {
  if (secret === undefined || secret === null || secret === "") {
    return { secret: generateWebhookSecret(), ref: "generated" }
  }

  if (typeof secret !== "string" || secret.trim().length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new Error(
      `Webhook secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`
    )
  }

  return { secret: secret.trim(), ref: "provided" }
}

function mapSubscription(row: SubscriptionRow): WebhookSubscriptionView {
  return {
    id: row.id,
    url: row.url,
    events: parseEvents(row.events),
    enabled: row.enabled,
    secretRef: row.secret_ref ?? undefined,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at),
  }
}

function mapDelivery(row: DeliveryRow): WebhookDeliveryView {
  return {
    id: row.id,
    subscriptionId: row.webhook_subscription_id,
    subscriptionUrl: row.subscription_url,
    eventName: row.event_name,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts ?? undefined,
    responseStatus: row.response_status ?? undefined,
    lastError: row.last_error ?? undefined,
    deliveredAt: toIso(row.delivered_at),
    durationMs: row.duration_ms ?? undefined,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at),
  }
}

/** Signs a sample event with the given secret so operators can verify their receiver. */
export function createWebhookTestSignature(url: string, secret: string) {
  const event = createPlatformEvent("summary.created", { url })
  const signature = signWebhookPayload(event, secret)

  return { event, signature }
}

export async function listWebhookSubscriptions() {
  if (!isPostgres()) {
    return [...memorySubscriptions.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
  }

  const result = await getDatabasePool().query(
    `
      select ${SUBSCRIPTION_COLUMNS}
      from webhook_subscriptions
      order by created_at desc
    `
  )

  return (result.rows as SubscriptionRow[]).map(mapSubscription)
}

/**
 * Creates a subscription after the SSRF guard accepts its URL. The signing
 * secret is stored encrypted and returned exactly once, here.
 */
export async function createWebhookSubscription(input: {
  url: string
  events?: unknown
  secret?: unknown
}): Promise<Required<WebhookSubscriptionWithSecret>> {
  const url = await assertSafeWebhookUrl(input.url)
  const events = normalizeEvents(input.events)
  const { secret, ref } = resolveNewSecret(input.secret)

  if (!isPostgres()) {
    const subscription = {
      id: createId("wh"),
      url,
      events,
      enabled: true,
      secretRef: ref,
      createdAt: new Date().toISOString(),
    } satisfies WebhookSubscriptionView

    memorySubscriptions.set(subscription.id, subscription)
    memorySecrets.set(subscription.id, secret)

    return { subscription, secret }
  }

  const result = await getDatabasePool().query(
    `
      insert into webhook_subscriptions (
        id, url, events, secret_ref, secret_hash, secret_ciphertext, enabled,
        updated_at
      )
      values ($1, $2, $3::jsonb, $4, $5, $6, true, now())
      returning ${SUBSCRIPTION_COLUMNS}
    `,
    [
      createId("wh"),
      url,
      JSON.stringify(events),
      ref,
      createApiKeyHash(secret),
      encryptWebhookSecret(secret),
    ]
  )

  return { subscription: mapSubscription(result.rows[0] as SubscriptionRow), secret }
}

export async function updateWebhookSubscription(
  id: string,
  patch: {
    url?: unknown
    enabled?: unknown
    events?: unknown
    rotateSecret?: unknown
  }
): Promise<WebhookSubscriptionWithSecret> {
  const url =
    typeof patch.url === "string" ? await assertSafeWebhookUrl(patch.url) : undefined
  const enabled = typeof patch.enabled === "boolean" ? patch.enabled : undefined
  const events =
    patch.events === undefined ? undefined : normalizeEvents(patch.events)
  const secret = patch.rotateSecret === true ? generateWebhookSecret() : undefined

  if (
    url === undefined &&
    enabled === undefined &&
    events === undefined &&
    secret === undefined
  ) {
    throw new Error("No webhook subscription changes were provided")
  }

  if (!isPostgres()) {
    const subscription = memorySubscriptions.get(id)

    if (!subscription) throw new WebhookNotFoundError("Webhook subscription not found")

    const updated = {
      ...subscription,
      url: url ?? subscription.url,
      enabled: enabled ?? subscription.enabled,
      events: events ?? subscription.events,
      secretRef: secret ? "generated" : subscription.secretRef,
      updatedAt: new Date().toISOString(),
    } satisfies WebhookSubscriptionView

    memorySubscriptions.set(id, updated)
    if (secret) memorySecrets.set(id, secret)

    return { subscription: updated, secret }
  }

  const updates: string[] = []
  const values: unknown[] = []

  if (url !== undefined) {
    values.push(url)
    updates.push(`url = $${values.length}`)
  }

  if (enabled !== undefined) {
    values.push(enabled)
    updates.push(`enabled = $${values.length}`)
  }

  if (events !== undefined) {
    values.push(JSON.stringify(events))
    updates.push(`events = $${values.length}::jsonb`)
  }

  if (secret !== undefined) {
    values.push(encryptWebhookSecret(secret))
    updates.push(`secret_ciphertext = $${values.length}`)
    values.push(createApiKeyHash(secret))
    updates.push(`secret_hash = $${values.length}`)
    updates.push(`secret_ref = 'generated'`)
  }

  values.push(id)
  const result = await getDatabasePool().query(
    `
      update webhook_subscriptions
      set ${updates.join(", ")},
          updated_at = now()
      where id = $${values.length}
      returning ${SUBSCRIPTION_COLUMNS}
    `,
    values
  )
  const row = result.rows[0] as SubscriptionRow | undefined

  if (!row) throw new WebhookNotFoundError("Webhook subscription not found")

  return { subscription: mapSubscription(row), secret }
}

/** Deletes a subscription together with its delivery history. */
export async function deleteWebhookSubscription(id: string) {
  if (!isPostgres()) {
    if (!memorySubscriptions.delete(id)) {
      throw new WebhookNotFoundError("Webhook subscription not found")
    }
    memorySecrets.delete(id)
    for (const [deliveryId, delivery] of memoryDeliveries) {
      if (delivery.subscriptionId === id) memoryDeliveries.delete(deliveryId)
    }
    return { id, deleted: true }
  }

  // One statement: the FK from webhook_deliveries is checked at statement end,
  // after the CTE has removed the dependent rows.
  const result = await getDatabasePool().query(
    `
      with removed_deliveries as (
        delete from webhook_deliveries where webhook_subscription_id = $1
      )
      delete from webhook_subscriptions
      where id = $1
      returning id
    `,
    [id]
  )

  if (!result.rows[0]) {
    throw new WebhookNotFoundError("Webhook subscription not found")
  }

  return { id, deleted: true }
}

export async function listWebhookDeliveries(options: {
  subscriptionId?: string
  limit?: number
} = {}) {
  if (!isPostgres()) {
    return [...memoryDeliveries.values()]
      .filter((delivery) =>
        options.subscriptionId
          ? delivery.subscriptionId === options.subscriptionId
          : true
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100))
  }

  const values: unknown[] = []
  const clauses: string[] = []

  if (options.subscriptionId) {
    values.push(options.subscriptionId)
    clauses.push(`d.webhook_subscription_id = $${values.length}`)
  }

  values.push(Math.min(Math.max(Math.trunc(options.limit || 25), 1), 100))
  const limitIndex = values.length
  const where = clauses.length ? `where ${clauses.join(" and ")}` : ""
  const result = await getDatabasePool().query(
    `
      select ${DELIVERY_COLUMNS}
      from webhook_deliveries d
      join webhook_subscriptions s on s.id = d.webhook_subscription_id
      ${where}
      order by d.created_at desc
      limit $${limitIndex}
    `,
    values
  )

  return (result.rows as DeliveryRow[]).map(mapDelivery)
}

async function getDeliveryView(id: string) {
  const result = await getDatabasePool().query(
    `
      select ${DELIVERY_COLUMNS}
      from webhook_deliveries d
      join webhook_subscriptions s on s.id = d.webhook_subscription_id
      where d.id = $1
      limit 1
    `,
    [id]
  )
  const row = result.rows[0] as DeliveryRow | undefined

  if (!row) throw new WebhookNotFoundError("Webhook delivery not found")

  return mapDelivery(row)
}

/**
 * Re-queues a delivery: resets it to `queued` with a fresh attempt budget and
 * enqueues a `webhook.deliver` job. Falls back to one inline attempt when the
 * queue is unavailable.
 */
export async function retryWebhookDelivery(id: string) {
  if (!isPostgres()) {
    const delivery = memoryDeliveries.get(id)

    if (!delivery) throw new WebhookNotFoundError("Webhook delivery not found")

    const updated = {
      ...delivery,
      status: "queued",
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    } satisfies WebhookDeliveryView

    memoryDeliveries.set(id, updated)
    return updated
  }

  const pool = getDatabasePool()
  const result = await pool.query(
    `
      select d.id, d.status, s.enabled
      from webhook_deliveries d
      join webhook_subscriptions s on s.id = d.webhook_subscription_id
      where d.id = $1
      limit 1
    `,
    [id]
  )
  const row = result.rows[0] as
    | { id: string; status: string; enabled: boolean }
    | undefined

  if (!row) throw new WebhookNotFoundError("Webhook delivery not found")
  if (!row.enabled) throw new Error("Webhook subscription is disabled")
  if (row.status === "sent") throw new Error("Webhook delivery was already sent")

  const maxAttempts = getWebhookMaxAttempts()
  await pool.query(
    `
      update webhook_deliveries
      set status = 'queued',
          max_attempts = $2,
          last_error = null,
          updated_at = now()
      where id = $1
    `,
    [id, maxAttempts]
  )

  try {
    await enqueueWebhookDelivery(id, maxAttempts)
  } catch {
    await processWebhookDeliveryJob({ deliveryId: id, attempt: 1, maxAttempts: 1 }).catch(
      () => undefined
    )
  }

  return getDeliveryView(id)
}

async function getSubscriptionForTest(id: string) {
  if (!isPostgres()) {
    const subscription = memorySubscriptions.get(id)
    if (!subscription) throw new WebhookNotFoundError("Webhook subscription not found")
    return {
      url: subscription.url,
      enabled: subscription.enabled,
      secret: memorySecrets.get(id) ?? getWebhookSigningSecret(),
    }
  }

  const result = await getDatabasePool().query(
    `
      select url, enabled, secret_ciphertext
      from webhook_subscriptions
      where id = $1
      limit 1
    `,
    [id]
  )
  const row = result.rows[0] as
    | { url: string; enabled: boolean; secret_ciphertext: string | null }
    | undefined

  if (!row) throw new WebhookNotFoundError("Webhook subscription not found")

  return {
    url: row.url,
    enabled: row.enabled,
    secret: resolveSubscriptionSecret(row),
  }
}

/**
 * Sends a signed test event through the SSRF guard. A subscription test uses
 * that subscription's own secret; an ad-hoc URL test uses the global secret.
 */
export async function sendWebhookTest(input: {
  url?: string
  subscriptionId?: string
  eventName?: WebhookEventName
}) {
  const eventName = normalizeEvents(
    input.eventName ? [input.eventName] : ["meeting.completed"]
  )[0]
  let url: string | undefined
  let secret: string | undefined

  if (input.url) {
    url = await assertSafeWebhookUrl(input.url)
  } else if (input.subscriptionId) {
    const subscription = await getSubscriptionForTest(input.subscriptionId)

    if (!subscription.enabled) throw new Error("Webhook subscription is disabled")
    url = subscription.url
    secret = subscription.secret
  }

  if (!url) throw new Error("Webhook URL or subscriptionId is required")

  const event = createPlatformEvent(eventName, {
    test: true,
    source: "meetsum",
    sentAt: new Date().toISOString(),
  })
  const deliveryId = createId("whtest")
  const response = await guardedWebhookFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-meetsum-signature": signWebhookPayload(
        event,
        secret ?? getWebhookSigningSecret()
      ),
      "x-meetsum-event": event.name,
      "x-meetsum-delivery": deliveryId,
    },
    body: JSON.stringify(event),
    timeoutMs: getWebhookFetchTimeoutMs(),
  })

  return {
    event,
    url,
    status: response.ok ? "sent" : "failed",
    responseStatus: response.status,
  }
}
