import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { apiError, auditActor, limitFor, readJsonBody } from "@/lib/integrations/core/api"
import { auditIntegration } from "@/lib/integrations/core/audit"
import { loadConnectionFor } from "@/lib/integrations/core/connection-access"
import { disconnectConnection, patchConnectionConfig, toConnectionDTO, validateConfigPatch } from "@/lib/integrations/core/connections"
import { getIntegrationStore } from "@/lib/integrations/core/store"

/**
 * /api/integrations/connections/[id] (M8 A2).
 * PATCH `{config}`: the per-provider allowlist only. Workspace connection →
 * `integrations:manage`; personal → owner only.
 * DELETE: disconnect (best-effort provider revoke, tokens wiped, rules
 * disabled, queued deliveries cancelled). Personal → owner, or an admin.
 */
export const PATCH = withAuthz<{ id: string }>("integrations:connect", async (request, ctx, route) => {
  const limited = await limitFor(request, ctx, "integrationsWrite")

  if (limited) return limited

  const { id } = await route.params
  const store = await getIntegrationStore()
  const access = await loadConnectionFor(store, ctx, id, "configure")

  if (!access.ok) return apiError(access.code, access.status)

  const body = (await readJsonBody(request)) as { config?: unknown } | undefined
  const patch = validateConfigPatch(access.connection.provider, body?.config)

  if (!patch.ok) return apiError(patch.error, 400)

  // Merged under the row lock into the current config (never the copy read above).
  const updated = await patchConnectionConfig(store, ctx.workspace.id, id, patch.config)

  if (!updated) return apiError("not_found", 404)

  await auditIntegration(auditActor(ctx), "integration.connection.updated", { type: "integration_connection", id }, {
    provider: updated.provider,
    fields: Object.keys(patch.config),
  })

  return NextResponse.json({ connection: toConnectionDTO(updated) })
})

export const DELETE = withAuthz<{ id: string }>("integrations:connect", async (request, ctx, route) => {
  const limited = await limitFor(request, ctx, "integrationsWrite")

  if (limited) return limited

  const { id } = await route.params
  const store = await getIntegrationStore()
  const access = await loadConnectionFor(store, ctx, id, "revoke")

  if (!access.ok) return apiError(access.code, access.status)

  const result = await disconnectConnection(access.connection, auditActor(ctx), store)

  return NextResponse.json(result)
})
