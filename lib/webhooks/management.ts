import { createApiKeyHash } from "@/lib/auth/api-keys"
import { getDatabasePool } from "@/lib/db/client"
import {
  createPlatformEvent,
  signWebhookPayload,
  type PlatformEventName,
} from "@/lib/platform/events"

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
  responseStatus?: number
  lastError?: string
  createdAt: string
  updatedAt?: string
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
  response_status: number | null
  last_error: string | null
  created_at: string | Date
  updated_at?: string | Date | null
}

const memorySubscriptions = new Map<string, WebhookSubscriptionView>()
const memoryDeliveries = new Map<string, WebhookDeliveryView>()

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

function validateWebhookUrl(url: string) {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    throw new Error("Webhook URL must be a valid absolute URL")
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Webhook URL must use http or https")
  }

  return parsed.toString()
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
    responseStatus: row.response_status ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at),
  }
}

export function createWebhookTestSignature(url: string) {
  const event = createPlatformEvent("summary.created", { url })
  const signature = signWebhookPayload(
    event,
    process.env.WEBHOOK_SIGNING_SECRET ?? "dev-secret"
  )

  return { event, signature }
}

export async function listWebhookSubscriptions() {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    return [...memorySubscriptions.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
  }

  const result = await getDatabasePool().query(
    `
      select id, url, events, enabled, secret_ref, created_at, updated_at
      from webhook_subscriptions
      order by created_at desc
    `
  )

  return (result.rows as SubscriptionRow[]).map(mapSubscription)
}

export async function createWebhookSubscription(input: {
  url: string
  events?: unknown
  secret?: string
}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    const subscription = {
      id: createId("wh"),
      url: validateWebhookUrl(input.url),
      events: normalizeEvents(input.events),
      enabled: true,
      secretRef: "global",
      createdAt: new Date().toISOString(),
    } satisfies WebhookSubscriptionView

    memorySubscriptions.set(subscription.id, subscription)

    return subscription
  }

  const url = validateWebhookUrl(input.url)
  const events = normalizeEvents(input.events)
  const result = await getDatabasePool().query(
    `
      insert into webhook_subscriptions (
        id, url, events, secret_ref, secret_hash, enabled, updated_at
      )
      values ($1, $2, $3::jsonb, $4, $5, true, now())
      returning id, url, events, enabled, secret_ref, created_at, updated_at
    `,
    [
      createId("wh"),
      url,
      JSON.stringify(events),
      input.secret ? "provided" : "global",
      input.secret ? createApiKeyHash(input.secret) : null,
    ]
  )

  return mapSubscription(result.rows[0] as SubscriptionRow)
}

export async function updateWebhookSubscription(
  id: string,
  patch: { enabled?: boolean; events?: unknown }
) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    const subscription = memorySubscriptions.get(id)

    if (!subscription) throw new Error("Webhook subscription not found")

    const updated = {
      ...subscription,
      enabled: patch.enabled ?? subscription.enabled,
      events:
        patch.events === undefined
          ? subscription.events
          : normalizeEvents(patch.events),
    } satisfies WebhookSubscriptionView

    memorySubscriptions.set(id, updated)

    return updated
  }

  const updates: string[] = []
  const values: unknown[] = []

  if (typeof patch.enabled === "boolean") {
    values.push(patch.enabled)
    updates.push(`enabled = $${values.length}`)
  }

  if (patch.events !== undefined) {
    values.push(JSON.stringify(normalizeEvents(patch.events)))
    updates.push(`events = $${values.length}::jsonb`)
  }

  if (!updates.length) {
    throw new Error("No webhook subscription changes were provided")
  }

  values.push(id)
  const result = await getDatabasePool().query(
    `
      update webhook_subscriptions
      set ${updates.join(", ")},
          updated_at = now()
      where id = $${values.length}
      returning id, url, events, enabled, secret_ref, created_at, updated_at
    `,
    values
  )
  const row = result.rows[0] as SubscriptionRow | undefined

  if (!row) throw new Error("Webhook subscription not found")

  return mapSubscription(row)
}

export async function listWebhookDeliveries(options: {
  subscriptionId?: string
  limit?: number
} = {}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
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

  values.push(Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100))
  const limitIndex = values.length
  const where = clauses.length ? `where ${clauses.join(" and ")}` : ""
  const result = await getDatabasePool().query(
    `
      select d.id, d.webhook_subscription_id, s.url as subscription_url,
             d.event_name, d.status, d.attempts, d.response_status,
             d.last_error, d.created_at, d.updated_at
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

export async function retryWebhookDelivery(id: string) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    const delivery = memoryDeliveries.get(id)

    if (!delivery) throw new Error("Webhook delivery not found")

    const updated = {
      ...delivery,
      status: "sent",
      attempts: delivery.attempts + 1,
      responseStatus: 200,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    } satisfies WebhookDeliveryView

    memoryDeliveries.set(id, updated)
    return updated
  }

  const pool = getDatabasePool()
  const result = await pool.query(
    `
      select d.id, d.webhook_subscription_id, s.url as subscription_url,
             d.event_name, d.status, d.attempts, d.event_payload,
             s.enabled
      from webhook_deliveries d
      join webhook_subscriptions s on s.id = d.webhook_subscription_id
      where d.id = $1
      limit 1
    `,
    [id]
  )
  const row = result.rows[0] as
    | {
        id: string
        webhook_subscription_id: string
        subscription_url: string
        event_name: string
        attempts: number
        event_payload: Record<string, unknown>
        enabled: boolean
      }
    | undefined

  if (!row) throw new Error("Webhook delivery not found")
  if (!row.enabled) throw new Error("Webhook subscription is disabled")

  await pool.query(
    `
      update webhook_deliveries
      set status = 'active',
          attempts = attempts + 1,
          last_error = null,
          updated_at = now()
      where id = $1
    `,
    [id]
  )

  try {
    const event = row.event_payload as Parameters<typeof signWebhookPayload>[0]
    const response = await fetch(row.subscription_url, {
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

    const updateResult = await pool.query(
      `
        update webhook_deliveries
        set status = $2,
            response_status = $3,
            updated_at = now()
        where id = $1
        returning id, webhook_subscription_id, $4::text as subscription_url,
                  event_name, status, attempts, response_status, last_error,
                  created_at, updated_at
      `,
      [id, response.ok ? "sent" : "failed", response.status, row.subscription_url]
    )

    return mapDelivery(updateResult.rows[0] as DeliveryRow)
  } catch (error) {
    const updateResult = await pool.query(
      `
        update webhook_deliveries
        set status = 'failed',
            last_error = $2,
            updated_at = now()
        where id = $1
        returning id, webhook_subscription_id, $3::text as subscription_url,
                  event_name, status, attempts, response_status, last_error,
                  created_at, updated_at
      `,
      [
        id,
        error instanceof Error ? error.message : "Webhook delivery failed",
        row.subscription_url,
      ]
    )

    return mapDelivery(updateResult.rows[0] as DeliveryRow)
  }
}

export async function sendWebhookTest(input: {
  url?: string
  subscriptionId?: string
  eventName?: WebhookEventName
}) {
  const eventName = normalizeEvents(
    input.eventName ? [input.eventName] : ["meeting.completed"]
  )[0]
  let url = input.url ? validateWebhookUrl(input.url) : undefined

  if (!url && input.subscriptionId) {
    const subscription = (await listWebhookSubscriptions()).find(
      (item) => item.id === input.subscriptionId
    )

    if (!subscription) throw new Error("Webhook subscription not found")
    if (!subscription.enabled) throw new Error("Webhook subscription is disabled")
    url = subscription.url
  }

  if (!url) throw new Error("Webhook URL or subscriptionId is required")

  const event = createPlatformEvent(eventName, {
    test: true,
    source: "meetsum",
    sentAt: new Date().toISOString(),
  })
  const response = await fetch(url, {
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

  return {
    event,
    url,
    status: response.ok ? "sent" : "failed",
    responseStatus: response.status,
  }
}
