/**
 * Client calls for Settings → Integrations and the per-meeting controls
 * (docs/parity/m8.md, Package D). D calls only HTTP APIs; the request and
 * response shapes follow the spec (A1–A8, C4) and the frozen types in
 * lib/integrations/core/types.ts. Every result is `{ok: true, body}` or
 * `{ok: false, status, code}`; `code` is the API's error code and is never
 * shown raw (callers map it to a localized message).
 */
import type {
  EmailRecapPreference,
  IntegrationConnectionDTO,
  IntegrationDeliveryDTO,
  IntegrationRuleDTO,
  MeetingIntegrationPrefs,
  PickerPage,
  ProviderInfo,
} from "@/lib/integrations/core/types"
import type { CatalogEvent, RuleRequest, WebhookPayloadVersion } from "@/components/integrations/state"

export type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; code: string }

async function call<T>(input: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response

  try {
    response = await fetch(input, {
      cache: "no-store",
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    })
  } catch {
    return { ok: false, status: 0, code: "network" }
  }

  const body = (await response.json().catch(() => undefined)) as unknown

  if (!response.ok) {
    const error = (body as { error?: unknown; code?: unknown } | undefined) ?? {}
    const code = typeof error.code === "string" ? error.code : typeof error.error === "string" ? error.error : "unknown"

    return { ok: false, status: response.status, code }
  }

  return { ok: true, status: response.status, body: body as T }
}

function json(method: string, body: unknown, headers?: Record<string, string>): RequestInit {
  return { method, body: JSON.stringify(body), headers }
}

/** Accepts `{key: T[]}` or a bare array. */
function list<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[]
  const value = (body as Record<string, unknown> | undefined)?.[key]

  return Array.isArray(value) ? (value as T[]) : []
}

async function mapped<T, R>(promise: Promise<ApiResult<T>>, map: (body: T) => R): Promise<ApiResult<R>> {
  const result = await promise

  return result.ok ? { ...result, body: map(result.body) } : result
}

export type ConnectionsResponse = { connections: IntegrationConnectionDTO[]; fake: boolean }

export type WebhookSubscriptionView = {
  id: string
  url: string
  events: string[]
  enabled: boolean
  secretRef?: string
  payloadVersion?: WebhookPayloadVersion
  createdAt: string
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
  payloadVersion?: number
  createdAt: string
}

export type MeetingPrefsResponse = {
  prefs: MeetingIntegrationPrefs
  /**
   * Whether the workspace has an enabled email recap rule (members can't read
   * rules). Assumed field of the A8 GET response; absent → hidden.
   */
  emailRecapAvailable: boolean
}

const enc = encodeURIComponent

export const integrationsApi = {
  providers: () =>
    mapped(call<unknown>("/api/integrations/providers"), (body) => list<ProviderInfo>(body, "providers")),

  connections: () =>
    mapped(call<unknown>("/api/integrations/connections"), (body): ConnectionsResponse => {
      const connections = list<IntegrationConnectionDTO>(body, "connections")
      const fake = Boolean((body as { fake?: unknown } | undefined)?.fake) || connections.some((connection) => connection.fake)

      return { connections, fake }
    }),

  updateConnection: (id: string, config: Record<string, unknown>) =>
    call<{ connection?: IntegrationConnectionDTO }>(`/api/integrations/connections/${enc(id)}`, json("PATCH", { config })),

  disconnect: (id: string) =>
    call<{ connection?: IntegrationConnectionDTO }>(`/api/integrations/connections/${enc(id)}`, { method: "DELETE" }),

  testConnection: (id: string) =>
    call<{ ok?: boolean }>(`/api/integrations/connections/${enc(id)}/test`, { method: "POST" }),

  picker: (connectionId: string, picker: string, query: { query?: string; cursor?: string }) => {
    const params = new URLSearchParams()

    if (query.query) params.set("query", query.query)
    if (query.cursor) params.set("cursor", query.cursor)

    return mapped(
      call<PickerPage>(`/api/integrations/connections/${enc(connectionId)}/options/${enc(picker)}?${params}`),
      (body): PickerPage => ({ items: Array.isArray(body?.items) ? body.items : [], nextCursor: body?.nextCursor })
    )
  },

  rules: () => mapped(call<unknown>("/api/integrations/rules"), (body) => list<IntegrationRuleDTO>(body, "rules")),

  createRule: (request: RuleRequest) => call<{ rule: IntegrationRuleDTO }>("/api/integrations/rules", json("POST", request)),

  updateRule: (id: string, request: Partial<RuleRequest>) =>
    call<{ rule: IntegrationRuleDTO }>(`/api/integrations/rules/${enc(id)}`, json("PATCH", request)),

  deleteRule: (id: string) => call<unknown>(`/api/integrations/rules/${enc(id)}`, { method: "DELETE" }),

  deliveries: (query: string) =>
    mapped(call<unknown>(`/api/integrations/deliveries?${query}`), (body) => ({
      deliveries: list<IntegrationDeliveryDTO>(body, "deliveries"),
      nextCursor: (body as { nextCursor?: string } | undefined)?.nextCursor,
    })),

  delivery: (id: string) =>
    mapped(call<unknown>(`/api/integrations/deliveries/${enc(id)}`), (body) => {
      const value = body as { delivery?: IntegrationDeliveryDTO } & IntegrationDeliveryDTO

      return value.delivery ?? value
    }),

  retryDelivery: (id: string) => call<unknown>(`/api/integrations/deliveries/${enc(id)}/retry`, { method: "POST" }),

  meetingPrefs: (meetingId: string) =>
    mapped(call<unknown>(`/api/meetings/${enc(meetingId)}/integration-prefs`), (body): MeetingPrefsResponse => {
      const value = (body ?? {}) as { prefs?: MeetingIntegrationPrefs; emailRecapAvailable?: unknown } & Partial<MeetingIntegrationPrefs>
      const prefs = value.prefs ?? (value as MeetingIntegrationPrefs)

      return {
        prefs: {
          ...prefs,
          allowPrivatePush: Boolean(prefs.allowPrivatePush),
          emailRecap: prefs.emailRecap ?? "inherit",
        },
        emailRecapAvailable: value.emailRecapAvailable === true,
      }
    }),

  updateMeetingPrefs: (meetingId: string, patch: { allowPrivatePush?: boolean; emailRecap?: EmailRecapPreference }) =>
    call<unknown>(`/api/meetings/${enc(meetingId)}/integration-prefs`, json("PUT", patch)),

  sendMeeting: (meetingId: string, connectionId: string, idempotencyKey: string) =>
    call<{ deliveryId: string }>(
      `/api/meetings/${enc(meetingId)}/integrations/send`,
      json("POST", { connectionId }, { "idempotency-key": idempotencyKey })
    ),

  realizeosStatus: () =>
    mapped(call<{ status?: { configured?: boolean } }>("/api/integrations/realizeos/status"), (body) => Boolean(body?.status?.configured)),

  /** Admin-only and capture-workspace-only (404 elsewhere); the card hides on any failure. */
  teamsCapture: () =>
    mapped(
      call<{ configured?: boolean; subscriptions?: unknown[] }>("/api/integrations/teams/subscription"),
      (body) => Boolean(body?.configured) && (body?.subscriptions?.length ?? 0) > 0
    ),

  // Webhooks (existing M1/M2 routes plus the C4 catalog and versioning)
  webhookCatalog: () =>
    mapped(call<{ version?: number; events?: CatalogEvent[] }>("/api/webhooks/catalog"), (body) => ({
      version: body?.version ?? 1,
      events: Array.isArray(body?.events) ? body.events : [],
    })),

  webhookSubscriptions: () =>
    mapped(call<unknown>("/api/webhooks/subscriptions"), (body) => list<WebhookSubscriptionView>(body, "subscriptions")),

  createWebhook: (url: string, events: string[], payloadVersion: WebhookPayloadVersion = 2) =>
    call<{ subscription: WebhookSubscriptionView; secret?: string }>(
      "/api/webhooks/subscriptions",
      json("POST", { url, events, payloadVersion })
    ),

  updateWebhook: (id: string, patch: { enabled?: boolean; payloadVersion?: WebhookPayloadVersion; events?: string[]; rotateSecret?: boolean }) =>
    call<{ subscription?: WebhookSubscriptionView; secret?: string }>(`/api/webhooks/subscriptions/${enc(id)}`, json("PATCH", patch)),

  deleteWebhook: (id: string) => call<unknown>(`/api/webhooks/subscriptions/${enc(id)}`, { method: "DELETE" }),

  testWebhook: (target: { subscriptionId: string } | { url: string }, eventName: string) =>
    call<{ responseStatus?: number; status?: string }>("/api/webhooks/test", json("POST", { ...target, eventName })),

  webhookDeliveries: (query: string) =>
    mapped(call<unknown>(`/api/webhooks/deliveries?${query}`), (body) => ({
      deliveries: list<WebhookDeliveryView>(body, "deliveries"),
      nextCursor: (body as { nextCursor?: string } | undefined)?.nextCursor,
    })),

  retryWebhookDelivery: (id: string) => call<unknown>(`/api/webhooks/deliveries/${enc(id)}/retry`, { method: "POST" }),
}
