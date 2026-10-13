/**
 * Per-connection authorization for the connection routes (docs/parity/m8.md
 * "Route → permission map"). Owner: Package A.
 *
 * - Workspace connection (slack, notion, hubspot): configure/test/revoke
 *   need `integrations:manage`.
 * - Personal connection (microsoft, google_drive): only the owner may
 *   configure, test or use it; admins may revoke (DELETE) it.
 * - Another workspace's id, or someone else's personal connection seen by
 *   a non-admin, is 404 (never disclosed).
 */
import { can, type AuthContext } from "@/lib/auth/authz"
import { actorUserId } from "@/lib/integrations/core/api"
import { isPersonalProvider, toConnectionDTO, toConnectionSummaryDTO } from "@/lib/integrations/core/connections"
import type { IntegrationStore, StoredConnection } from "@/lib/integrations/core/store"
import type { IntegrationConnectionDTO } from "@/lib/integrations/core/types"

export type ConnectionAction = "configure" | "test" | "revoke" | "use"

export type ConnectionAccess = { ok: true; connection: StoredConnection } | { ok: false; status: 403 | 404; code: string }

export async function loadConnectionFor(
  store: IntegrationStore,
  ctx: Pick<AuthContext, "workspace" | "role" | "user" | "apiKey">,
  connectionId: string,
  action: ConnectionAction
): Promise<ConnectionAccess> {
  const connection = await store.getConnection(ctx.workspace.id, connectionId)

  if (!connection || connection.status === "revoked") return { ok: false, status: 404, code: "not_found" }

  const isAdmin = can(ctx.role, "integrations:manage")

  if (isPersonalProvider(connection.provider)) {
    const isOwner = Boolean(connection.userId && connection.userId === actorUserId(ctx))

    if (isOwner) return { ok: true, connection }
    if (!isAdmin) return { ok: false, status: 404, code: "not_found" }
    return action === "revoke" ? { ok: true, connection } : { ok: false, status: 403, code: "forbidden" }
  }

  if (action === "use") return { ok: true, connection }
  return isAdmin ? { ok: true, connection } : { ok: false, status: 403, code: "forbidden" }
}

/** What `GET /api/integrations/connections` shows to this viewer. */
export function visibleConnections(
  rows: StoredConnection[],
  ctx: Pick<AuthContext, "role" | "user" | "apiKey">
): IntegrationConnectionDTO[] {
  const me = actorUserId(ctx)
  const isAdmin = can(ctx.role, "integrations:manage")

  return rows.flatMap((row) => {
    if (!isPersonalProvider(row.provider)) return [toConnectionDTO(row)]
    if (row.userId && row.userId === me) return [toConnectionDTO(row)]
    return isAdmin ? [toConnectionSummaryDTO(row)] : []
  })
}
