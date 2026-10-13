import { createApiKeyHash } from "@/lib/auth/api-keys"
import { getDatabasePool } from "@/lib/db/client"
import {
  WEBHOOK_EVENTS_V2,
  webhookEventsFor,
  type WebhookEventV2,
  type WebhookPayloadVersion,
} from "@/lib/platform/event-catalog"
import { webhookExampleData } from "@/lib/platform/event-schemas"
import {
  createPlatformEvent,
  signWebhookPayload,
  type PlatformEvent,
  type PlatformEventV2,
} from "@/lib/platform/events"
import {
  enqueueWebhookDelivery,
  processWebhookDeliveryJob,
  webhookRequestHeaders,
} from "@/lib/webhooks/delivery"
import {
  encryptWebhookSecret,
  generateWebhookSecret,
  getWebhookFetchTimeoutMs,
  getWebhookMaxAttempts,
  getWebhookMaxTotalAttempts,
  getWebhookSigningSecret,
  MIN_WEBHOOK_SECRET_LENGTH,
  resolveSubscriptionSecret,
} from "@/lib/webhooks/secret"
import {
  assertSafeWebhookUrl,
  guardedWebhookFetch,
} from "@/lib/webhooks/url-guard"

/** Every event of the catalog (v2 is a superset of v1). */
export const WEBHOOK_EVENT_NAMES = WEBHOOK_EVENTS_V2

export type WebhookEventName = WebhookEventV2

/** New subscriptions get the catalog version (M8 C4). */
export const DEFAULT_WEBHOOK_PAYLOAD_VERSION: WebhookPayloadVersion = 2

export type WebhookSubscriptionView = {
  id: string
  url: string
  events: WebhookEventName[]
  enabled: boolean
  /** 1 = legacy payloads (frozen), 2 = catalog payloads. Always set by the store. */
  payloadVersion?: WebhookPayloadVersion
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
  payloadVersion?: WebhookPayloadVersion
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

/** Invalid input (unknown event, event outside the version, downgrade) → 400. */
export class WebhookValidationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "WebhookValidationError"
    this.code = code
  }
}

type SubscriptionRow = {
  id: string
  url: string
  events: string[] | string
  enabled: boolean
  payload_version?: number | null
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
  payload_version?: number | null
  response_status: number | null
  last_error: string | null
  delivered_at?: string | Date | null
  duration_ms?: number | null
  created_at: string | Date
  updated_at?: string | Date | null
}

const SUBSCRIPTION_COLUMNS =
  "id, url, events, enabled, payload_version, secret_ref, created_at, updated_at"
const DELIVERY_COLUMNS = `d.id, d.webhook_subscription_id, s.url as subscription_url,
             d.event_name, d.status, d.attempts, d.max_attempts, d.payload_version,
             d.response_status, d.last_error, d.delivered_at, d.duration_ms,
             d.created_at, d.updated_at`

const memorySubscriptions = new Map<string, WebhookSubscriptionView>()
const memorySecrets = new Map<string, string>()
const memoryDeliveries = new Map<string, WebhookDeliveryView>()
/** subscription id -> owning workspace id (memory storage). */
const memoryWorkspaces = new Map<string, string>()

function isPostgres() {
  return process.env.MEETSUM_STORAGE === "postgres"
}

function requireWorkspaceId(workspaceId: string) {
  if (!workspaceId?.trim()) throw new Error("workspaceId is required")

  return workspaceId
}

/** A memory subscription visible to `workspaceId`, or undefined. */
function memorySubscriptionIn(workspaceId: string, id: string) {
  return memoryWorkspaces.get(id) === workspaceId
    ? memorySubscriptions.get(id)
    : undefined
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

function toIso(value: string | Date | null | undefined) {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toVersion(value: unknown): WebhookPayloadVersion {
  return Number(value) === 2 ? 2 : 1
}

/** `payloadVersion` from a request: 1, 2 or undefined; anything else → 400. */
function parseRequestedVersion(value: unknown): WebhookPayloadVersion | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 1 || value === 2 || value === "1" || value === "2") return toVersion(value)

  throw new WebhookValidationError("invalid_payload_version", "payloadVersion must be 1 or 2")
}

/**
 * Events requested for a subscription of `version`. Missing or empty → every
 * event of that version. An unknown event, or one outside the version (e.g.
 * `clip.created` on a v1 subscription), is refused (400).
 */
function requestedEvents(events: unknown, version: WebhookPayloadVersion): WebhookEventName[] {
  const allowed = webhookEventsFor(version)

  if (events === undefined || events === null) return [...allowed]
  if (!Array.isArray(events)) {
    throw new WebhookValidationError("invalid_events", "events must be an array of event names")
  }
  if (!events.length) return [...allowed]

  for (const event of events) {
    if (!(allowed as readonly unknown[]).includes(event)) {
      throw new WebhookValidationError(
        "event_not_in_version",
        `Event ${String(event)} is not available in webhook payload version ${version}`
      )
    }
  }

  return [...new Set(events as WebhookEventName[])]
}

/** Stored events (lenient: unknown names are dropped). */
function parseEvents(events: string[] | string, version: WebhookPayloadVersion): WebhookEventName[] {
  const parsed = (typeof events === "string" ? JSON.parse(events) : events) as unknown
  const allowed = webhookEventsFor(version)
  const list = Array.isArray(parsed)
    ? parsed.filter((event): event is WebhookEventName => (allowed as readonly unknown[]).includes(event))
    : []

  return list.length ? [...new Set(list)] : [...allowed]
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
  const payloadVersion = toVersion(row.payload_version)

  return {
    id: row.id,
    url: row.url,
    events: parseEvents(row.events, payloadVersion),
    enabled: row.enabled,
    payloadVersion,
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
    payloadVersion: row.payload_version == null ? undefined : toVersion(row.payload_version),
    responseStatus: row.response_status ?? undefined,
    lastError: row.last_error ?? undefined,
    deliveredAt: toIso(row.delivered_at),
    durationMs: row.duration_ms ?? undefined,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at),
  }
}

/** Signs a sample event with the given secret so operators can verify their receiver. */
export function createWebhookTestSignature(
  url: string,
  secret: string,
  workspaceId?: string
) {
  const event = createPlatformEvent("summary.created", { url }, { workspaceId })
  const signature = signWebhookPayload(event, secret)

  return { event, signature }
}

/**
 * Every function below is scoped to one workspace: ids that belong to another
 * workspace behave exactly like unknown ids (WebhookNotFoundError → 404).
 */
export async function listWebhookSubscriptions(workspaceId: string) {
  requireWorkspaceId(workspaceId)

  if (!isPostgres()) {
    return [...memorySubscriptions.values()]
      .filter((subscription) => memoryWorkspaces.get(subscription.id) === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  const result = await getDatabasePool().query(
    `
      select ${SUBSCRIPTION_COLUMNS}
      from webhook_subscriptions
      where workspace_id = $1
      order by created_at desc
    `,
    [workspaceId]
  )

  return (result.rows as SubscriptionRow[]).map(mapSubscription)
}

/**
 * Creates a subscription after the SSRF guard accepts its URL. The signing
 * secret is stored encrypted and returned exactly once, here. New
 * subscriptions default to payload version 2 (the catalog).
 */
export async function createWebhookSubscription(
  workspaceId: string,
  input: {
    url: string
    events?: unknown
    secret?: unknown
    payloadVersion?: unknown
  }
): Promise<Required<WebhookSubscriptionWithSecret>> {
  requireWorkspaceId(workspaceId)
  const payloadVersion = parseRequestedVersion(input.payloadVersion) ?? DEFAULT_WEBHOOK_PAYLOAD_VERSION
  const events = requestedEvents(input.events, payloadVersion)
  const url = await assertSafeWebhookUrl(input.url)
  const { secret, ref } = resolveNewSecret(input.secret)

  if (!isPostgres()) {
    const subscription = {
      id: createId("wh"),
      url,
      events,
      enabled: true,
      payloadVersion,
      secretRef: ref,
      createdAt: new Date().toISOString(),
    } satisfies WebhookSubscriptionView

    memorySubscriptions.set(subscription.id, subscription)
    memorySecrets.set(subscription.id, secret)
    memoryWorkspaces.set(subscription.id, workspaceId)

    return { subscription, secret }
  }

  const result = await getDatabasePool().query(
    `
      insert into webhook_subscriptions (
        id, workspace_id, url, events, secret_ref, secret_hash,
        secret_ciphertext, enabled, updated_at, payload_version
      )
      values ($1, $2, $3, $4::jsonb, $5, $6, $7, true, now(), $8)
      returning ${SUBSCRIPTION_COLUMNS}
    `,
    [
      createId("wh"),
      workspaceId,
      url,
      JSON.stringify(events),
      ref,
      createApiKeyHash(secret),
      encryptWebhookSecret(secret),
      payloadVersion,
    ]
  )

  return { subscription: mapSubscription(result.rows[0] as SubscriptionRow), secret }
}

async function currentPayloadVersion(workspaceId: string, id: string): Promise<WebhookPayloadVersion> {
  if (!isPostgres()) {
    const subscription = memorySubscriptionIn(workspaceId, id)

    if (!subscription) throw new WebhookNotFoundError("Webhook subscription not found")

    return subscription.payloadVersion ?? 1
  }

  const result = await getDatabasePool().query(
    `
      select payload_version
      from webhook_subscriptions
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [id, workspaceId]
  )
  const row = result.rows[0] as { payload_version?: number | null } | undefined

  if (!row) throw new WebhookNotFoundError("Webhook subscription not found")

  return toVersion(row.payload_version)
}

/**
 * Updates url, enabled, events, the payload version (1 → 2 only; the
 * upgrade is one-way) or rotates the secret. Events are checked against the
 * subscription's (new) version.
 */
export async function updateWebhookSubscription(
  workspaceId: string,
  id: string,
  patch: {
    url?: unknown
    enabled?: unknown
    events?: unknown
    rotateSecret?: unknown
    payloadVersion?: unknown
  }
): Promise<WebhookSubscriptionWithSecret> {
  requireWorkspaceId(workspaceId)
  const requestedVersion = parseRequestedVersion(patch.payloadVersion)
  let payloadVersion: WebhookPayloadVersion | undefined
  let events: WebhookEventName[] | undefined

  if (requestedVersion !== undefined || patch.events !== undefined) {
    const current = await currentPayloadVersion(workspaceId, id)

    if (requestedVersion === 1 && current === 2) {
      throw new WebhookValidationError(
        "payload_version_downgrade",
        "A v2 webhook subscription cannot go back to v1 payloads"
      )
    }
    if (requestedVersion === 2 && current === 1) payloadVersion = 2
    if (patch.events !== undefined) events = requestedEvents(patch.events, requestedVersion ?? current)
  }

  const url =
    typeof patch.url === "string" ? await assertSafeWebhookUrl(patch.url) : undefined
  const enabled = typeof patch.enabled === "boolean" ? patch.enabled : undefined
  const secret = patch.rotateSecret === true ? generateWebhookSecret() : undefined

  if (
    url === undefined &&
    enabled === undefined &&
    events === undefined &&
    secret === undefined &&
    payloadVersion === undefined &&
    requestedVersion === undefined
  ) {
    throw new Error("No webhook subscription changes were provided")
  }

  if (!isPostgres()) {
    const subscription = memorySubscriptionIn(workspaceId, id)

    if (!subscription) throw new WebhookNotFoundError("Webhook subscription not found")

    const updated = {
      ...subscription,
      url: url ?? subscription.url,
      enabled: enabled ?? subscription.enabled,
      events: events ?? subscription.events,
      payloadVersion: payloadVersion ?? subscription.payloadVersion,
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

  if (payloadVersion !== undefined) {
    values.push(payloadVersion)
    updates.push(`payload_version = $${values.length}`)
  }

  if (secret !== undefined) {
    values.push(encryptWebhookSecret(secret))
    updates.push(`secret_ciphertext = $${values.length}`)
    values.push(createApiKeyHash(secret))
    updates.push(`secret_hash = $${values.length}`)
    updates.push(`secret_ref = 'generated'`)
  }

  values.push(id)
  const idIndex = values.length
  values.push(workspaceId)
  const result = await getDatabasePool().query(
    `
      update webhook_subscriptions
      set ${updates.length ? `${updates.join(", ")},` : ""}
          updated_at = now()
      where id = $${idIndex} and workspace_id = $${values.length}
      returning ${SUBSCRIPTION_COLUMNS}
    `,
    values
  )
  const row = result.rows[0] as SubscriptionRow | undefined

  if (!row) throw new WebhookNotFoundError("Webhook subscription not found")

  return { subscription: mapSubscription(row), secret }
}

/** Deletes a subscription together with its delivery history. */
export async function deleteWebhookSubscription(workspaceId: string, id: string) {
  requireWorkspaceId(workspaceId)

  if (!isPostgres()) {
    if (!memorySubscriptionIn(workspaceId, id)) {
      throw new WebhookNotFoundError("Webhook subscription not found")
    }
    memorySubscriptions.delete(id)
    memorySecrets.delete(id)
    memoryWorkspaces.delete(id)
    for (const [deliveryId, delivery] of memoryDeliveries) {
      if (delivery.subscriptionId === id) memoryDeliveries.delete(deliveryId)
    }
    return { id, deleted: true }
  }

  // One statement: the FK from webhook_deliveries is checked at statement end,
  // after the CTE has removed the dependent rows. Both deletes only touch a
  // subscription of this workspace.
  const result = await getDatabasePool().query(
    `
      with target as (
        select id from webhook_subscriptions
        where id = $1 and workspace_id = $2
      ),
      removed_deliveries as (
        delete from webhook_deliveries
        where webhook_subscription_id in (select id from target)
      )
      delete from webhook_subscriptions
      where id in (select id from target)
      returning id
    `,
    [id, workspaceId]
  )

  if (!result.rows[0]) {
    throw new WebhookNotFoundError("Webhook subscription not found")
  }

  return { id, deleted: true }
}

export async function listWebhookDeliveries(
  workspaceId: string,
  options: {
    subscriptionId?: string
    limit?: number
  } = {}
) {
  requireWorkspaceId(workspaceId)

  if (!isPostgres()) {
    return [...memoryDeliveries.values()]
      .filter((delivery) => memoryWorkspaces.get(delivery.subscriptionId) === workspaceId)
      .filter((delivery) =>
        options.subscriptionId
          ? delivery.subscriptionId === options.subscriptionId
          : true
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100))
  }

  const values: unknown[] = [workspaceId]
  const clauses: string[] = ["s.workspace_id = $1"]

  if (options.subscriptionId) {
    values.push(options.subscriptionId)
    clauses.push(`d.webhook_subscription_id = $${values.length}`)
  }

  values.push(Math.min(Math.max(Math.trunc(options.limit || 25), 1), 100))
  const limitIndex = values.length
  const result = await getDatabasePool().query(
    `
      select ${DELIVERY_COLUMNS}
      from webhook_deliveries d
      join webhook_subscriptions s on s.id = d.webhook_subscription_id
      where ${clauses.join(" and ")}
      order by d.created_at desc
      limit $${limitIndex}
    `,
    values
  )

  return (result.rows as DeliveryRow[]).map(mapDelivery)
}

async function getDeliveryView(workspaceId: string, id: string) {
  const result = await getDatabasePool().query(
    `
      select ${DELIVERY_COLUMNS}
      from webhook_deliveries d
      join webhook_subscriptions s on s.id = d.webhook_subscription_id
      where d.id = $1 and s.workspace_id = $2
      limit 1
    `,
    [id, workspaceId]
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
export async function retryWebhookDelivery(workspaceId: string, id: string) {
  requireWorkspaceId(workspaceId)

  if (!isPostgres()) {
    const delivery = memoryDeliveries.get(id)

    if (!delivery || memoryWorkspaces.get(delivery.subscriptionId) !== workspaceId) {
      throw new WebhookNotFoundError("Webhook delivery not found")
    }

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
      select d.id, d.status, d.attempts, s.enabled
      from webhook_deliveries d
      join webhook_subscriptions s on s.id = d.webhook_subscription_id
      where d.id = $1 and s.workspace_id = $2
      limit 1
    `,
    [id, workspaceId]
  )
  const row = result.rows[0] as
    | { id: string; status: string; attempts: number; enabled: boolean }
    | undefined

  if (!row) throw new WebhookNotFoundError("Webhook delivery not found")
  if (!row.enabled) throw new Error("Webhook subscription is disabled")
  if (row.status === "sent") throw new Error("Webhook delivery was already sent")
  if (row.status === "queued" || row.status === "active" || row.status === "retrying") {
    throw new Error("Webhook delivery is already in progress")
  }

  // A retry only gets the attempt budget that is left under the lifetime cap,
  // so repeated manual retries cannot keep a delivery hammering a receiver.
  const remaining = getWebhookMaxTotalAttempts() - (row.attempts ?? 0)

  if (remaining <= 0) {
    throw new Error("Webhook delivery has exhausted its total attempt budget")
  }

  const maxAttempts = Math.min(getWebhookMaxAttempts(), remaining)
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

  return getDeliveryView(workspaceId, id)
}

async function getSubscriptionForTest(workspaceId: string, id: string) {
  if (!isPostgres()) {
    const subscription = memorySubscriptionIn(workspaceId, id)
    if (!subscription) throw new WebhookNotFoundError("Webhook subscription not found")
    return {
      url: subscription.url,
      enabled: subscription.enabled,
      payloadVersion: subscription.payloadVersion ?? 1,
      secret: memorySecrets.get(id) ?? getWebhookSigningSecret(),
    }
  }

  const result = await getDatabasePool().query(
    `
      select url, enabled, secret_ciphertext, payload_version
      from webhook_subscriptions
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [id, workspaceId]
  )
  const row = result.rows[0] as
    | { url: string; enabled: boolean; secret_ciphertext: string | null; payload_version?: number | null }
    | undefined

  if (!row) throw new WebhookNotFoundError("Webhook subscription not found")

  return {
    url: row.url,
    enabled: row.enabled,
    payloadVersion: toVersion(row.payload_version),
    secret: resolveSubscriptionSecret(row),
  }
}

/**
 * The test-fire envelope of `eventName` in `version`: the catalog example
 * data (schema-valid) in the real envelope, flagged `test: true`.
 */
export function buildWebhookTestEvent(
  eventName: WebhookEventName,
  version: WebhookPayloadVersion,
  workspaceId: string
): PlatformEvent<Record<string, unknown>> | PlatformEventV2<Record<string, unknown>> {
  const data = webhookExampleData(eventName, version)

  if (!data) {
    throw new WebhookValidationError(
      "event_not_in_version",
      `Event ${eventName} is not available in webhook payload version ${version}`
    )
  }

  const base = createPlatformEvent(eventName, data, { workspaceId })

  return version === 2
    ? { id: base.id, name: base.name, version: 2, occurredAt: base.occurredAt, workspace_id: workspaceId, data, test: true }
    : { ...base, test: true }
}

/**
 * Sends a signed test event through the SSRF guard: the catalog example
 * payload of `eventName` for the subscription's version (ad-hoc URLs:
 * `payloadVersion`, default 2), with every production header. A
 * subscription test uses that subscription's own secret. An ad-hoc URL test
 * is signed with a fresh throwaway secret (returned once as `secret`) and
 * never with the global WEBHOOK_SIGNING_SECRET: signing attacker-chosen
 * payloads with the global secret would hand out valid signatures for
 * legacy subscriptions.
 */
export async function sendWebhookTest(
  workspaceId: string,
  input: {
    url?: string
    subscriptionId?: string
    eventName?: WebhookEventName
    payloadVersion?: unknown
  }
) {
  requireWorkspaceId(workspaceId)
  const eventName: WebhookEventName = input.eventName ?? "meeting.completed"
  let url: string | undefined
  let secret: string | undefined
  let adHocSecret: string | undefined
  let version: WebhookPayloadVersion = parseRequestedVersion(input.payloadVersion) ?? DEFAULT_WEBHOOK_PAYLOAD_VERSION

  if (input.url) {
    url = await assertSafeWebhookUrl(input.url)
    adHocSecret = generateWebhookSecret()
    secret = adHocSecret
  } else if (input.subscriptionId) {
    const subscription = await getSubscriptionForTest(workspaceId, input.subscriptionId)

    if (!subscription.enabled) throw new Error("Webhook subscription is disabled")
    url = subscription.url
    secret = subscription.secret
    version = subscription.payloadVersion
  }

  if (!url || !secret) throw new Error("Webhook URL or subscriptionId is required")

  const event = buildWebhookTestEvent(eventName, version, workspaceId)
  const body = JSON.stringify(event)
  const deliveryId = createId("whtest")
  const response = await guardedWebhookFetch(url, {
    method: "POST",
    headers: webhookRequestHeaders({
      body,
      secret,
      v1Signature: signWebhookPayload(event as PlatformEvent<Record<string, unknown>>, secret),
      eventName: event.name,
      deliveryId,
      version,
    }),
    body,
    timeoutMs: getWebhookFetchTimeoutMs(),
  })

  return {
    event,
    payloadVersion: version,
    url,
    status: response.ok ? "sent" : "failed",
    responseStatus: response.status,
    ...(adHocSecret ? { secret: adHocSecret } : {}),
  }
}

export function isWebhookEventName(value: unknown): value is WebhookEventName {
  return (WEBHOOK_EVENTS_V2 as readonly unknown[]).includes(value)
}
