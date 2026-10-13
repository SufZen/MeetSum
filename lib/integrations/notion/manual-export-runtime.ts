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
 * Integration step: register A's implementation once at boot (or replace
 * `loadDefaultRuntime` below):
 *   setManualExportRuntime({
 *     providerFetch,                                   // core/http
 *     findActiveConnection,                            // core/connection-store (DTO, no tokens)
 *     getAccessToken: (ws, id) => getAccessToken(id),  // core/tokens
 *     linkStore,                                       // core/link-store (ws + connection scoped)
 *     startManualDelivery, finishManualDelivery,       // core/delivery-store (origin "manual")
 *     saveDeliveryProgress,
 *   })
 */
import type {
  DeliverResult,
  DeliveryProgress,
  IntegrationConnectionDTO,
  IntegrationDeliveryDTO,
  LinkStore,
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
  ): Promise<IntegrationConnectionDTO | undefined>
  /** A fresh access token (refreshed under a row lock when needed). */
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
}

let registered: ManualExportRuntime | undefined

export function setManualExportRuntime(runtime: ManualExportRuntime | undefined): void {
  registered = runtime
}

/** Integration step: wire Package A here if no boot hook registers it. */
function loadDefaultRuntime(): ManualExportRuntime | undefined {
  return undefined
}

export function getManualExportRuntime(): ManualExportRuntime | undefined {
  return registered ?? loadDefaultRuntime()
}
