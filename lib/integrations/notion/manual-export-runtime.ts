/**
 * The Package A services the manual export routes need (Notion export,
 * Google Docs export), behind one seam (docs/parity/m8.md, C1/C2).
 * Owner: Package C.
 *
 * Package A (OAuth core, token store, link store, delivery store,
 * `providerFetch`) is built in parallel, so Package C codes against this
 * interface and its tests use doubles. Until the runtime is registered the
 * export routes fail closed (409 "not connected"), never with a token from
 * the request or the environment.
 *
 * Integration step: `loadDefaultRuntime` below is Package A's real
 * implementation (`providerFetch`, the integrations store, `getAccessToken`,
 * the scoped link store and manual delivery rows). Tests replace it with
 * `setManualExportRuntime`.
 */
import type {
  DeliverResult,
  DeliveryProgress,
  IntegrationConnectionDTO,
  IntegrationDeliveryDTO,
  IntegrationLinkKey,
  LinkStore,
  MeetingIntegrationPrefs,
  ProviderFetch,
  ProviderId,
} from "@/lib/integrations/core/types"

export type StartManualDeliveryInput = {
  workspaceId: string
  connectionId: string
  provider: ProviderId
  meetingId: string
  /** `manual:{Idempotency-Key}`; a repeated key returns the same delivery. */
  idempotencyKey: string
  requestedByUserId?: string
  eventName?: string
}

/**
 * The connection DTO plus the token generation read with it (server-side
 * only, never serialized): an `auth` failure of this export is flagged
 * `needs_reauth` only while the connection is still at that generation.
 */
export type ManualExportConnection = IntegrationConnectionDTO & { generation?: number }

/** `{ generation }` for `flagNeedsReauthOnAuth` when the connection carries one. */
export function reauthGeneration(connection: ManualExportConnection): { generation?: number } {
  return typeof connection.generation === "number" ? { generation: connection.generation } : {}
}

export type ManualExportRuntime = {
  /** Outbound provider HTTP (exact-host allowlist, no redirects, caps). */
  providerFetch: ProviderFetch
  /**
   * The active connection of `provider` in the workspace: the workspace
   * connection, or the user's personal one when `userId` is given.
   */
  findActiveConnection(
    workspaceId: string,
    provider: ProviderId,
    options?: { userId?: string }
  ): Promise<ManualExportConnection | undefined>
  /** A fresh access token (refreshed under a refresh lease when needed). */
  getAccessToken(workspaceId: string, connectionId: string): Promise<string>
  /** Links of one connection and meeting (integration_links). */
  linkStore(workspaceId: string, connectionId: string, meetingId: string): LinkStore
  /**
   * Inserts (or, for a repeated key, returns) the manual delivery row;
   * `progress` is the stored checkpoint so a retried request resumes.
   */
  startManualDelivery(
    input: StartManualDeliveryInput
  ): Promise<{ delivery: IntegrationDeliveryDTO; replayed: boolean; progress?: DeliveryProgress }>
  saveDeliveryProgress(workspaceId: string, deliveryId: string, progress: DeliveryProgress): Promise<void>
  finishManualDelivery(
    workspaceId: string,
    deliveryId: string,
    outcome: { result: DeliverResult } | { error: { kind: string; message: string } }
  ): Promise<void>
  /** Per-meeting prefs for the single privacy gate (defaults to the integrations store). */
  getPrefs?(
    workspaceId: string,
    meetingId: string
  ): Promise<Pick<MeetingIntegrationPrefs, "allowPrivatePush" | "allowPrivateSetByUserId"> | undefined>
}

let registered: ManualExportRuntime | undefined

export function setManualExportRuntime(runtime: ManualExportRuntime | undefined): void {
  registered = runtime
}

const store = async () => (await import("@/lib/integrations/core/store")).getIntegrationStore()

/** Package A's services, imported lazily (no import cycle with the registry). */
const defaultRuntime: ManualExportRuntime = {
  providerFetch: async (provider, url, init) => (await import("@/lib/integrations/core/http")).providerFetch(provider, url, init),

  async findActiveConnection(workspaceId, provider, options = {}) {
    const [db, { isPersonalProvider, toConnectionDTO }] = await Promise.all([
      store(),
      import("@/lib/integrations/core/connections"),
    ])
    const personal = isPersonalProvider(provider)

    if (personal && !options.userId) return undefined

    const row = (await db.listConnections(workspaceId)).find(
      (candidate) =>
        candidate.provider === provider &&
        candidate.status === "active" &&
        (personal ? candidate.userId === options.userId : !candidate.userId)
    )

    return row ? { ...toConnectionDTO(row), generation: row.generation } : undefined
  },

  async getAccessToken(workspaceId, connectionId) {
    const { getAccessToken } = await import("@/lib/integrations/core/tokens")

    return getAccessToken(workspaceId, connectionId)
  },

  linkStore(workspaceId, connectionId, meetingId) {
    const scope = { workspaceId, connectionId, meetingId }
    const provider = async () => (await (await store()).getConnection(workspaceId, connectionId))?.provider

    return {
      get: async (key: IntegrationLinkKey) => (await store()).getLink(scope, key),
      list: async (objectKind, destinationKey) => (await store()).listLinks(scope, objectKind, destinationKey),
      upsert: async (key) => {
        const owner = await provider()

        if (!owner) throw new Error("connection not found")
        return (await store()).upsertLink({ ...scope, provider: owner }, key)
      },
      remove: async (key) => (await store()).removeLink(scope, key),
    }
  },

  async startManualDelivery(input) {
    const [db, { deliveryDTO }, { integrationMaxAttempts }] = await Promise.all([
      store(),
      import("@/lib/integrations/core/deliver"),
      import("@/lib/integrations/core/limits"),
    ])
    const clientKey = input.idempotencyKey.replace(/^manual:/, "")
    const { delivery, created } = await db.insertDelivery({
      id: `intd_${crypto.randomUUID()}`,
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      provider: input.provider,
      origin: "manual",
      eventName: input.eventName ?? "manual.export",
      meetingId: input.meetingId,
      // Scoped to provider and requester: another user's key never replays.
      idempotencyKey: `manual:export:${input.provider}:${input.requestedByUserId ?? "system"}:${clientKey}`,
      status: "running",
      maxAttempts: integrationMaxAttempts(),
      ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
    })
    const sameTarget = delivery.meetingId === input.meetingId && delivery.connectionId === input.connectionId

    if (!created && !sameTarget) throw new Error("idempotency key reused for another target")

    return { delivery: deliveryDTO(delivery), replayed: !created, progress: { ...delivery.progress } }
  },

  async saveDeliveryProgress(workspaceId, deliveryId, progress) {
    await (await store()).updateDelivery(workspaceId, deliveryId, { progress })
  },

  async finishManualDelivery(workspaceId, deliveryId, outcome) {
    const db = await store()
    const now = new Date().toISOString()

    if ("result" in outcome) {
      await db.updateDelivery(workspaceId, deliveryId, {
        status: outcome.result.status,
        completedAt: now,
        externalRef: outcome.result.externalRef,
        ...(outcome.result.skipReason ? { skipReason: outcome.result.skipReason } : {}),
        ...(outcome.result.progress ? { progress: outcome.result.progress } : {}),
      })
      return
    }

    const [{ storedIntegrationError }, { ProviderError }] = await Promise.all([
      import("@/lib/integrations/core/errors"),
      import("@/lib/integrations/core/types"),
    ])
    const row = await db.getDelivery(workspaceId, deliveryId)
    const kinds = ["auth", "forbidden", "not_found", "invalid", "rate_limited", "retryable", "config"] as const
    const kind = (kinds as readonly string[]).includes(outcome.error.kind) ? (outcome.error.kind as (typeof kinds)[number]) : "retryable"

    // Typed fields only: the message is never stored.
    await db.updateDelivery(workspaceId, deliveryId, {
      status: "failed",
      completedAt: now,
      lastError: storedIntegrationError(new ProviderError(kind, "manual export failed"), row?.provider),
    })
  },

  async getPrefs(workspaceId, meetingId) {
    return (await store()).getPrefs(workspaceId, meetingId)
  },
}

function loadDefaultRuntime(): ManualExportRuntime {
  return defaultRuntime
}

export function getManualExportRuntime(): ManualExportRuntime | undefined {
  return registered ?? loadDefaultRuntime()
}

/** Prefs for the privacy gate: the runtime's, else the integrations store's. */
export async function manualExportPrefs(
  runtime: ManualExportRuntime,
  workspaceId: string,
  meetingId: string
): Promise<Pick<MeetingIntegrationPrefs, "allowPrivatePush" | "allowPrivateSetByUserId"> | undefined> {
  if (runtime.getPrefs) return runtime.getPrefs(workspaceId, meetingId)

  return (await store()).getPrefs(workspaceId, meetingId)
}
