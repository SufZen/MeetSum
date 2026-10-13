/**
 * `needs_reauth` transition (docs/parity/m8.md, "Outbound HTTP" kind auth
 * and "Token refresh"). Owner: Package A. Sets the status and a redacted
 * `last_error`, notifies the connection's creator (M5 `integration_reauth`)
 * and audits `integration.connection.needs_reauth`. Idempotent: an already
 * flagged connection is not re-notified.
 *
 * The flag is a compare-and-set on the token generation observed WITH the
 * failure (`updateConnectionIfCurrent`: `status = 'active'` and the same
 * generation). A failure of an older token therefore never flips a
 * connection that was reconnected (new generation) or disconnected
 * (`revoked`, new generation) in the meantime, and a lost CAS neither
 * notifies nor audits.
 */
import { auditIntegration } from "@/lib/integrations/core/audit"
import { storedIntegrationError } from "@/lib/integrations/core/errors"
import { getIntegrationStore, type IntegrationStore } from "@/lib/integrations/core/store"
import { enqueueIntegrationReauthNotification } from "@/lib/notifications/enqueue"

export type ReauthDeps = {
  store?: IntegrationStore
  notify?: typeof enqueueIntegrationReauthNotification
}

export type MarkReauthDeps = ReauthDeps & {
  /**
   * The connection generation the failing token belonged to (captured
   * before the provider call). Omitted only by callers that hold no
   * generation (legacy DTO paths); the current row's generation is then
   * read here, which is best effort.
   */
  generation?: number
}

/** Errors about the connection's own state (not a rejected grant): never `needs_reauth`. */
export const CONNECTION_STATE_CODES: ReadonlySet<string> = new Set(["connection_changed", "connection_inactive"])

export function isConnectionStateError(error: unknown): boolean {
  const code = error instanceof Error ? (error as { providerCode?: unknown }).providerCode : undefined

  return typeof code === "string" && CONNECTION_STATE_CODES.has(code)
}

export async function markConnectionNeedsReauth(
  workspaceId: string,
  connectionId: string,
  reason: unknown,
  deps: MarkReauthDeps = {}
): Promise<void> {
  if (isConnectionStateError(reason)) return

  const store = deps.store ?? (await getIntegrationStore())
  const connection = await store.getConnection(workspaceId, connectionId)

  if (!connection || connection.status !== "active") return

  // CAS: only the generation that produced the failure can be flagged.
  const flagged = await store.updateConnectionIfCurrent(workspaceId, connectionId, deps.generation ?? connection.generation, {
    status: "needs_reauth",
    lastError: storedIntegrationError(reason, connection.provider),
  })

  if (!flagged) return

  const recipient = connection.userId ?? connection.createdByUserId

  if (recipient) {
    await (deps.notify ?? enqueueIntegrationReauthNotification)({
      workspaceId,
      userId: recipient,
      connectionId,
      provider: connection.provider,
    }).catch(() => undefined)
  }

  await auditIntegration(
    { workspaceId, actor: "system:integrations" },
    "integration.connection.needs_reauth",
    { type: "integration_connection", id: connectionId },
    { provider: connection.provider, connectionId }
  )
}

/**
 * `ProviderError` kind `auth` (a provider 401, revoked or expired grant) →
 * `needs_reauth`, from any path that calls a provider outside the delivery
 * worker (pickers, destination checks, manual exports). Other errors are
 * ignored. Never throws.
 */
export async function flagNeedsReauthOnAuth(
  workspaceId: string,
  connectionId: string,
  error: unknown,
  deps: MarkReauthDeps = {}
): Promise<void> {
  const kind = error instanceof Error ? (error as { kind?: unknown }).kind : undefined

  if (kind !== "auth") return
  await markConnectionNeedsReauth(workspaceId, connectionId, error, deps).catch(() => undefined)
}
