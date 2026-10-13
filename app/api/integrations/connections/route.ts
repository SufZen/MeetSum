import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { visibleConnections } from "@/lib/integrations/core/connection-access"
import { isFakeMode } from "@/lib/integrations/core/http"
import { getIntegrationStore } from "@/lib/integrations/core/store"

/**
 * GET /api/integrations/connections (M8 A2). Workspace connections (label,
 * status, non-secret config) plus my personal ones; admins also see
 * others' personal connections (label and status only). Never a token.
 */
export const GET = withAuthz("integrations:connect", async (_request, ctx) => {
  const store = await getIntegrationStore()
  const rows = await store.listConnections(ctx.workspace.id)

  return NextResponse.json({ connections: visibleConnections(rows, ctx), fake: isFakeMode() })
})
