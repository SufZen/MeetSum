import { getDatabasePool, type Queryable } from "@/lib/db/client"
import { graphFetch } from "@/lib/capture/teams"
import { getCaptureWorkspaceId } from "@/lib/capture/workspace"

/**
 * Microsoft Graph change-notification subscriptions for Teams recordings.
 *
 * Graph subscriptions for online-meeting recordings expire after at most
 * ~3 days, so the worker renews them periodically
 * (`teams.subscription.renew`). State lives in `capture_subscriptions`.
 */

export const DEFAULT_TEAMS_SUBSCRIPTION_RESOURCE =
  "communications/onlineMeetings/getAllRecordings"
export const DEFAULT_TEAMS_SUBSCRIPTION_EXPIRATION_MINUTES = 4200
export const DEFAULT_TEAMS_SUBSCRIPTION_RENEW_BEFORE_MINUTES = 720

export type CaptureSubscriptionStatus = "active" | "removed" | "failed"

export type CaptureSubscriptionRecord = {
  id: string
  platform: string
  externalSubscriptionId: string
  resource: string
  changeType: string
  notificationUrl: string
  lifecycleNotificationUrl?: string
  expiresAt: string
  status: CaptureSubscriptionStatus
  lastError?: string
  createdAt: string
  updatedAt: string
}

export type CaptureSubscriptionStore = {
  listActive: (platform: string) => Promise<CaptureSubscriptionRecord[]>
  listAll: (platform: string) => Promise<CaptureSubscriptionRecord[]>
  findByExternalId: (
    externalSubscriptionId: string
  ) => Promise<CaptureSubscriptionRecord | undefined>
  insert: (
    record: Omit<CaptureSubscriptionRecord, "createdAt" | "updatedAt">
  ) => Promise<CaptureSubscriptionRecord>
  update: (
    id: string,
    patch: {
      expiresAt?: string
      status?: CaptureSubscriptionStatus
      lastError?: string | null
    }
  ) => Promise<void>
}

export type TeamsSubscriptionConfig = {
  resource: string
  changeType: string
  notificationUrl: string
  lifecycleNotificationUrl: string
  clientState: string
  expirationMinutes: number
  renewBeforeMinutes: number
}

export type TeamsSubscriptionDeps = {
  store: CaptureSubscriptionStore
  graph: (path: string, init?: RequestInit) => Promise<Response>
  config: TeamsSubscriptionConfig
  createId?: () => string
}

type CaptureSubscriptionRow = {
  id: string
  platform: string
  external_subscription_id: string
  resource: string
  change_type: string
  notification_url: string
  lifecycle_notification_url: string | null
  expires_at: string | Date
  status: CaptureSubscriptionStatus
  last_error: string | null
  created_at: string | Date
  updated_at: string | Date
}

function toIso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapRow(row: CaptureSubscriptionRow): CaptureSubscriptionRecord {
  return {
    id: row.id,
    platform: row.platform,
    externalSubscriptionId: row.external_subscription_id,
    resource: row.resource,
    changeType: row.change_type,
    notificationUrl: row.notification_url,
    lifecycleNotificationUrl: row.lifecycle_notification_url ?? undefined,
    expiresAt: toIso(row.expires_at),
    status: row.status,
    lastError: row.last_error ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

/**
 * The Teams Graph subscription is instance-level and feeds the capture
 * workspace, so its rows are stamped with that workspace.
 */
export function createPostgresCaptureSubscriptionStore(
  db: Queryable = getDatabasePool(),
  workspaceId: string = getCaptureWorkspaceId()
): CaptureSubscriptionStore {
  return {
    async listActive(platform) {
      const result = await db.query(
        `select * from capture_subscriptions
          where platform = $1 and status = 'active'
          order by expires_at asc`,
        [platform]
      )
      return (result.rows as CaptureSubscriptionRow[]).map(mapRow)
    },
    async listAll(platform) {
      const result = await db.query(
        `select * from capture_subscriptions
          where platform = $1
          order by created_at desc
          limit 50`,
        [platform]
      )
      return (result.rows as CaptureSubscriptionRow[]).map(mapRow)
    },
    async findByExternalId(externalSubscriptionId) {
      const result = await db.query(
        `select * from capture_subscriptions where external_subscription_id = $1`,
        [externalSubscriptionId]
      )
      const row = result.rows[0] as CaptureSubscriptionRow | undefined
      return row ? mapRow(row) : undefined
    },
    async insert(record) {
      const result = await db.query(
        `insert into capture_subscriptions (
           id, platform, external_subscription_id, resource, change_type,
           notification_url, lifecycle_notification_url, expires_at, status, last_error,
           workspace_id
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (external_subscription_id) do update set
           expires_at = excluded.expires_at,
           status = excluded.status,
           last_error = excluded.last_error,
           updated_at = now()
         returning *`,
        [
          record.id,
          record.platform,
          record.externalSubscriptionId,
          record.resource,
          record.changeType,
          record.notificationUrl,
          record.lifecycleNotificationUrl ?? null,
          record.expiresAt,
          record.status,
          record.lastError ?? null,
          workspaceId,
        ]
      )
      return mapRow(result.rows[0] as CaptureSubscriptionRow)
    },
    async update(id, patch) {
      const sets: string[] = []
      const values: unknown[] = [id]

      if (patch.expiresAt !== undefined) {
        values.push(patch.expiresAt)
        sets.push(`expires_at = $${values.length}`)
      }
      if (patch.status !== undefined) {
        values.push(patch.status)
        sets.push(`status = $${values.length}`)
      }
      if (patch.lastError !== undefined) {
        values.push(patch.lastError)
        sets.push(`last_error = $${values.length}`)
      }

      if (!sets.length) return

      await db.query(
        `update capture_subscriptions set ${sets.join(", ")}, updated_at = now() where id = $1`,
        values
      )
    },
  }
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value)

  return value?.trim() && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback
}

function publicBaseUrl(env: NodeJS.ProcessEnv) {
  const raw = (env.MEETINGS_APP_URL || env.NEXT_PUBLIC_APP_URL || "").trim()

  if (!raw) return undefined

  try {
    const url = new URL(raw)

    // Graph only delivers notifications to public HTTPS endpoints.
    return url.protocol === "https:" ? url.origin + url.pathname.replace(/\/+$/, "") : undefined
  } catch {
    return undefined
  }
}

/** Returns the subscription config, or undefined when Teams capture isn't fully configured. */
export function getTeamsSubscriptionConfig(
  env: NodeJS.ProcessEnv = process.env
): TeamsSubscriptionConfig | undefined {
  const clientState = env.TEAMS_WEBHOOK_CLIENT_STATE?.trim()
  const base = publicBaseUrl(env)

  if (
    !clientState ||
    !base ||
    !env.AZURE_TENANT_ID?.trim() ||
    !env.AZURE_CLIENT_ID?.trim() ||
    !env.AZURE_CLIENT_SECRET?.trim()
  ) {
    return undefined
  }

  return {
    resource:
      env.TEAMS_SUBSCRIPTION_RESOURCE?.trim() || DEFAULT_TEAMS_SUBSCRIPTION_RESOURCE,
    changeType: "created",
    notificationUrl: `${base}/api/webhooks/teams`,
    lifecycleNotificationUrl: `${base}/api/webhooks/teams/lifecycle`,
    clientState,
    expirationMinutes: positiveInt(
      env.TEAMS_SUBSCRIPTION_EXPIRATION_MINUTES,
      DEFAULT_TEAMS_SUBSCRIPTION_EXPIRATION_MINUTES
    ),
    renewBeforeMinutes: positiveInt(
      env.TEAMS_SUBSCRIPTION_RENEW_BEFORE_MINUTES,
      DEFAULT_TEAMS_SUBSCRIPTION_RENEW_BEFORE_MINUTES
    ),
  }
}

export function isTeamsSubscriptionConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.MEETSUM_STORAGE === "postgres" && Boolean(getTeamsSubscriptionConfig(env))
}

function defaultDeps(): TeamsSubscriptionDeps | undefined {
  const config = getTeamsSubscriptionConfig()

  if (!config || process.env.MEETSUM_STORAGE !== "postgres") return undefined

  return {
    store: createPostgresCaptureSubscriptionStore(),
    graph: graphFetch,
    config,
  }
}

async function graphError(res: Response, action: string) {
  const text = await res.text().catch(() => "")
  let detail = text.slice(0, 300)

  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
    detail = [parsed.error?.code, parsed.error?.message].filter(Boolean).join(": ") || detail
  } catch {
    // keep raw text
  }

  return new GraphSubscriptionError(`${action} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status)
}

export class GraphSubscriptionError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "GraphSubscriptionError"
    this.status = status
  }
}

function expirationFrom(now: Date, minutes: number) {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}

async function createSubscription(
  deps: TeamsSubscriptionDeps,
  now: Date
): Promise<CaptureSubscriptionRecord> {
  const { config } = deps
  const res = await deps.graph("subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      changeType: config.changeType,
      notificationUrl: config.notificationUrl,
      lifecycleNotificationUrl: config.lifecycleNotificationUrl,
      resource: config.resource,
      expirationDateTime: expirationFrom(now, config.expirationMinutes),
      clientState: config.clientState,
      latestSupportedTlsVersion: "v1_2",
    }),
  })

  if (!res.ok) throw await graphError(res, "Graph subscription create")

  const body = (await res.json()) as { id?: string; expirationDateTime?: string }

  if (!body.id) {
    throw new GraphSubscriptionError("Graph subscription create returned no id", 502)
  }

  return deps.store.insert({
    id: deps.createId?.() ?? `capsub_${crypto.randomUUID()}`,
    platform: "teams",
    externalSubscriptionId: body.id,
    resource: config.resource,
    changeType: config.changeType,
    notificationUrl: config.notificationUrl,
    lifecycleNotificationUrl: config.lifecycleNotificationUrl,
    expiresAt: body.expirationDateTime
      ? toIso(body.expirationDateTime)
      : expirationFrom(now, config.expirationMinutes),
    status: "active",
  })
}

type RenewOutcome = "renewed" | "created"

/** PATCHes the expiry; a subscription Graph no longer knows (404) is recreated. */
async function renewSubscription(
  deps: TeamsSubscriptionDeps,
  record: CaptureSubscriptionRecord,
  now: Date
): Promise<RenewOutcome> {
  const expiresAt = expirationFrom(now, deps.config.expirationMinutes)
  const res = await deps.graph(
    `subscriptions/${encodeURIComponent(record.externalSubscriptionId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expirationDateTime: expiresAt }),
    }
  )

  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    await deps.store.update(record.id, {
      status: "removed",
      lastError: "Subscription no longer exists in Microsoft Graph",
    })
    await createSubscription(deps, now)
    return "created"
  }

  if (!res.ok) {
    const error = await graphError(res, "Graph subscription renew")

    await deps.store.update(record.id, {
      lastError: error.message,
      ...(new Date(record.expiresAt).getTime() <= now.getTime()
        ? { status: "failed" as const }
        : {}),
    })
    throw error
  }

  const body = (await res.json().catch(() => ({}))) as { expirationDateTime?: string }

  await deps.store.update(record.id, {
    expiresAt: body.expirationDateTime ? toIso(body.expirationDateTime) : expiresAt,
    lastError: null,
  })

  return "renewed"
}

function needsRenewal(
  record: CaptureSubscriptionRecord,
  now: Date,
  renewBeforeMinutes: number
) {
  return new Date(record.expiresAt).getTime() - now.getTime() <= renewBeforeMinutes * 60_000
}

/**
 * Makes sure an active subscription exists for the configured resource,
 * creating or renewing it as needed.
 */
export async function ensureTeamsSubscription(
  now = new Date(),
  deps: TeamsSubscriptionDeps | undefined = defaultDeps()
): Promise<{
  action: "existing" | "created" | "renewed"
  subscription: CaptureSubscriptionRecord
}> {
  if (!deps) {
    throw new GraphSubscriptionError(
      "Teams subscriptions are not configured (Azure credentials, TEAMS_WEBHOOK_CLIENT_STATE, an https MEETINGS_APP_URL and Postgres storage are required)",
      503
    )
  }

  const current = (await deps.store.listActive("teams")).find(
    (record) => record.resource === deps.config.resource
  )

  if (!current) {
    return { action: "created", subscription: await createSubscription(deps, now) }
  }

  if (!needsRenewal(current, now, deps.config.renewBeforeMinutes)) {
    return { action: "existing", subscription: current }
  }

  const outcome = await renewSubscription(deps, current, now)
  const refreshed = (await deps.store.listActive("teams")).find(
    (record) => record.resource === deps.config.resource
  )

  return { action: outcome, subscription: refreshed ?? current }
}

/**
 * Worker job (`teams.subscription.renew`): renews every active Teams
 * subscription that expires within the renew-before window, recreates
 * vanished ones, and creates the subscription if none exists.
 */
export async function renewTeamsSubscriptions(
  now = new Date(),
  deps: TeamsSubscriptionDeps | undefined = defaultDeps()
): Promise<{ renewed: number; created: number; failed: number }> {
  const result = { renewed: 0, created: 0, failed: 0 }

  if (!deps) return result

  const active = await deps.store.listActive("teams")

  for (const record of active) {
    if (!needsRenewal(record, now, deps.config.renewBeforeMinutes)) continue

    try {
      const outcome = await renewSubscription(deps, record, now)
      result[outcome] += 1
    } catch (error) {
      result.failed += 1
      console.error("[teams] subscription renewal failed", {
        subscriptionId: record.externalSubscriptionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const hasConfigured = (await deps.store.listActive("teams")).some(
    (record) => record.resource === deps.config.resource
  )

  if (!hasConfigured) {
    try {
      await createSubscription(deps, now)
      result.created += 1
    } catch (error) {
      result.failed += 1
      console.error("[teams] subscription create failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}

export type TeamsLifecycleOutcome = {
  subscriptionId: string
  lifecycleEvent: string
  action: "renewed" | "recreated" | "recorded" | "ignored" | "failed"
}

type LifecycleNotification = {
  subscriptionId?: string
  lifecycleEvent?: string
  clientState?: string
}

/**
 * Handles Graph lifecycle notifications: `reauthorizationRequired` renews,
 * `subscriptionRemoved` recreates, `missed` is recorded for operators.
 * Callers must validate `clientState` first.
 */
export async function handleTeamsLifecycleNotifications(
  notifications: LifecycleNotification[],
  now = new Date(),
  deps: TeamsSubscriptionDeps | undefined = defaultDeps()
): Promise<TeamsLifecycleOutcome[]> {
  const outcomes: TeamsLifecycleOutcome[] = []

  for (const notification of notifications) {
    const subscriptionId = String(notification.subscriptionId ?? "")
    const lifecycleEvent = String(notification.lifecycleEvent ?? "")
    const record =
      deps && subscriptionId
        ? await deps.store.findByExternalId(subscriptionId)
        : undefined

    if (!deps || !record) {
      outcomes.push({ subscriptionId, lifecycleEvent, action: "ignored" })
      continue
    }

    try {
      if (lifecycleEvent === "reauthorizationRequired") {
        const outcome = await renewSubscription(deps, record, now)
        outcomes.push({
          subscriptionId,
          lifecycleEvent,
          action: outcome === "created" ? "recreated" : "renewed",
        })
      } else if (lifecycleEvent === "subscriptionRemoved") {
        await deps.store.update(record.id, {
          status: "removed",
          lastError: "Removed by Microsoft Graph (lifecycle notification)",
        })
        await createSubscription(deps, now)
        outcomes.push({ subscriptionId, lifecycleEvent, action: "recreated" })
      } else if (lifecycleEvent === "missed") {
        await deps.store.update(record.id, {
          lastError: `Graph reported missed notifications at ${now.toISOString()}`,
        })
        outcomes.push({ subscriptionId, lifecycleEvent, action: "recorded" })
      } else {
        outcomes.push({ subscriptionId, lifecycleEvent, action: "ignored" })
      }
    } catch (error) {
      console.error("[teams] lifecycle handling failed", {
        subscriptionId,
        lifecycleEvent,
        error: error instanceof Error ? error.message : String(error),
      })
      outcomes.push({ subscriptionId, lifecycleEvent, action: "failed" })
    }
  }

  return outcomes
}

export async function listTeamsSubscriptions(
  deps: TeamsSubscriptionDeps | undefined = defaultDeps()
) {
  return deps ? deps.store.listAll("teams") : []
}
