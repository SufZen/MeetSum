import type {
  DeliverInput,
  DeliveryProgress,
  IntegrationConnectionDTO,
  IntegrationDeliveryDTO,
  IntegrationLink,
  IntegrationLinkKey,
  LinkStore,
  ProviderFetch,
  ProviderId,
} from "@/lib/integrations/core/types"
import { DEFAULT_RULE_CONTENT, type MeetingRecap } from "@/lib/integrations/recap"
import type { MeetingRecord } from "@/lib/meetings/repository"

/**
 * Test doubles for the Package A services Package C codes against (M8):
 * a scripted `providerFetch`, an in-memory link store and a DeliverInput
 * builder. No network, no database.
 */

export type RecordedCall = { provider: ProviderId; method: string; url: string; path: string; body: unknown; headers: Record<string, string> }

export type Route = (call: RecordedCall) => Response | Promise<Response> | undefined

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return Object.fromEntries(new URLSearchParams(body))
  }
}

/** A providerFetch that answers from `routes` (first match wins) and records every call. */
export function scriptedFetch(routes: Route[]): { fetch: ProviderFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetch: ProviderFetch = async (provider, url, init = {}) => {
    const parsed = new URL(url)
    const call: RecordedCall = {
      provider,
      method: (init.method ?? "GET").toUpperCase(),
      url,
      path: `${parsed.pathname}${parsed.search}`,
      body: typeof init.body === "string" ? parseBody(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    }

    calls.push(call)
    for (const route of routes) {
      const response = await route(call)

      if (response) return response
    }

    return json({ object: "error", status: 500, code: "unrouted", message: `${call.method} ${call.path}` }, 500)
  }

  return { fetch, calls }
}

/** `METHOD /path` (prefix match on the path) → response factory. */
export function on(method: string, pathPrefix: string | RegExp, respond: (call: RecordedCall) => Response | Promise<Response>): Route {
  return (call) => {
    if (call.method !== method) return undefined
    const matches = typeof pathPrefix === "string" ? call.path.startsWith(pathPrefix) : pathPrefix.test(call.path)

    return matches ? respond(call) : undefined
  }
}

export function memoryLinkStore(initial: IntegrationLink[] = [], connectionId = "intc_1", meetingId = "meet_1"): LinkStore & {
  rows: IntegrationLink[]
} {
  const rows = [...initial]
  const matches = (row: IntegrationLink, key: IntegrationLinkKey) =>
    row.objectKind === key.objectKind &&
    row.destinationKey === (key.destinationKey ?? "") &&
    row.actionItemId === (key.actionItemId ?? "")

  return {
    rows,
    async get(key) {
      return rows.find((row) => matches(row, key))
    },
    async list(objectKind, destinationKey) {
      return rows.filter((row) => row.objectKind === objectKind && (destinationKey === undefined || row.destinationKey === destinationKey))
    },
    async upsert(key) {
      const now = new Date().toISOString()
      const existing = rows.find((row) => matches(row, key))

      if (existing) {
        Object.assign(existing, { externalId: key.externalId, externalUrl: key.externalUrl, contentHash: key.contentHash, updatedAt: now })

        return existing
      }

      const row: IntegrationLink = {
        id: `intl_${rows.length + 1}`,
        connectionId,
        provider: "notion",
        meetingId,
        objectKind: key.objectKind,
        destinationKey: key.destinationKey ?? "",
        actionItemId: key.actionItemId ?? "",
        externalId: key.externalId,
        ...(key.externalUrl ? { externalUrl: key.externalUrl } : {}),
        ...(key.contentHash ? { contentHash: key.contentHash } : {}),
        createdAt: now,
        updatedAt: now,
      }

      rows.push(row)

      return row
    },
    async remove(key) {
      const index = rows.findIndex((row) => matches(row, key))

      if (index >= 0) rows.splice(index, 1)
    },
  }
}

export function connectionDto(provider: ProviderId, overrides: Partial<IntegrationConnectionDTO> = {}): IntegrationConnectionDTO {
  return {
    id: "intc_1",
    provider,
    status: "active",
    accountLabel: "Workspace",
    scopes: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    config: {},
    ...overrides,
  }
}

export function deliveryDto(provider: ProviderId, overrides: Partial<IntegrationDeliveryDTO> = {}): IntegrationDeliveryDTO {
  return {
    id: "intd_1",
    provider,
    origin: "manual",
    meetingId: "meet_1",
    status: "running",
    attempts: 1,
    maxAttempts: 5,
    externalRef: {},
    createdAt: "2026-10-12T08:00:00.000Z",
    updatedAt: "2026-10-12T08:00:00.000Z",
    ...overrides,
  }
}

export function deliverInput(options: {
  provider: ProviderId
  fetch: ProviderFetch
  recap: MeetingRecap
  destination: DeliverInput["destination"]
  links?: LinkStore
  progress?: DeliveryProgress
  token?: string
}): DeliverInput & { saved: DeliveryProgress[] } {
  const saved: DeliveryProgress[] = []

  return {
    workspaceId: "ws_1",
    delivery: deliveryDto(options.provider),
    connection: connectionDto(options.provider),
    getAccessToken: async () => options.token ?? "fixture_access_token",
    destination: options.destination,
    content: { ...DEFAULT_RULE_CONTENT, transcript: true },
    recap: options.recap,
    meeting: { id: options.recap.meetingId } as MeetingRecord,
    progress: options.progress ?? {},
    saveProgress: async (progress) => {
      saved.push(structuredClone(progress))
    },
    links: options.links ?? memoryLinkStore(),
    fetch: options.fetch,
    saved,
  }
}
