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
