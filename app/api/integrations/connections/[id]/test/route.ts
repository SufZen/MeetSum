import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { apiError, auditActor, limitFor } from "@/lib/integrations/core/api"
import { loadConnectionFor } from "@/lib/integrations/core/connection-access"
import { testConnection } from "@/lib/integrations/core/connections"
import { getIntegrationStore } from "@/lib/integrations/core/store"

/**
 * POST /api/integrations/connections/[id]/test (M8 A2). Runs the provider's
 * no-op call (Slack `auth.test`, …), updates `last_used_at`/`last_error`
 * and audits `integration.connection.tested`. Answers a fixed result code.
 */
export const POST = withAuthz<{ id: string }>("integrations:connect", async (request, ctx, route) => {
  const limited = await limitFor(request, ctx, "integrationsWrite")

  if (limited) return limited

  const { id } = await route.params
  const store = await getIntegrationStore()
  const access = await loadConnectionFor(store, ctx, id, "test")

  if (!access.ok) return apiError(access.code, access.status)

  return NextResponse.json(await testConnection(access.connection, auditActor(ctx), store))
})
