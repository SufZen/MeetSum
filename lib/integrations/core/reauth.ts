/**
 * `needs_reauth` transition (docs/parity/m8.md, "Outbound HTTP" kind auth
 * and "Token refresh"). Owner: Package A. Sets the status and a redacted
 * `last_error`, notifies the connection's creator (M5 `integration_reauth`)
 * and audits `integration.connection.needs_reauth`. Idempotent: an already
 * flagged connection is not re-notified.
 */
import { auditIntegration } from "@/lib/integrations/core/audit"
import { storedIntegrationError } from "@/lib/integrations/core/errors"
import { getIntegrationStore, type IntegrationStore } from "@/lib/integrations/core/store"
import { enqueueIntegrationReauthNotification } from "@/lib/notifications/enqueue"

export type ReauthDeps = {
  store?: IntegrationStore
  notify?: typeof enqueueIntegrationReauthNotification
}

export async function markConnectionNeedsReauth(
  workspaceId: string,
  connectionId: string,
  reason: unknown,
  deps: ReauthDeps = {}
): Promise<void> {
  const store = deps.store ?? (await getIntegrationStore())
  const connection = await store.getConnection(workspaceId, connectionId)

  if (!connection || connection.status === "revoked") return

  const already = connection.status === "needs_reauth"

  await store.updateConnection(workspaceId, connectionId, {
    status: "needs_reauth",
    lastError: storedIntegrationError(reason, connection.provider),
  })

  if (already) return

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
