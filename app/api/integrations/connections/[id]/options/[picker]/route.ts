import { NextResponse } from "next/server"

import { can, withAuthz } from "@/lib/auth/authz"
import { apiError, providerErrorResponse } from "@/lib/integrations/core/api"
import { loadConnectionFor } from "@/lib/integrations/core/connection-access"
import { isPersonalProvider, providerCtx } from "@/lib/integrations/core/connections"
import { flagNeedsReauthOnAuth } from "@/lib/integrations/core/reauth"
import { getProvider } from "@/lib/integrations/core/registry"
import { getIntegrationStore } from "@/lib/integrations/core/store"

/**
 * GET /api/integrations/connections/[id]/options/[picker]?q=&cursor=&purpose=rule|send
 * (M8). Destination pickers (Slack channels, Notion databases, HubSpot
 * deals). Rule pickers on a workspace connection need
 * `integrations:manage`; manual-send pickers need `allowManualSend`;
 * personal connections are owner-only.
 */
export const GET = withAuthz<{ id: string; picker: string }>("meeting:write", async (request, ctx, route) => {
  const { id, picker } = await route.params
  const url = new URL(request.url)
  const purpose = url.searchParams.get("purpose") === "rule" ? "rule" : "send"
  const store = await getIntegrationStore()
  const access = await loadConnectionFor(store, ctx, id, "use")

  if (!access.ok) return apiError(access.code, access.status)

  const { connection } = access

  if (!isPersonalProvider(connection.provider)) {
    if (purpose === "rule" && !can(ctx.role, "integrations:manage")) return apiError("forbidden", 403)
    if (purpose === "send" && connection.config.allowManualSend === false) return apiError("manual_send_disabled", 403)
  }
  if (connection.status !== "active") return apiError("integration_needs_reauth", 409)

  const handler = getProvider(connection.provider)?.pickers?.[picker]

  if (!handler) return apiError("not_found", 404)

  const query = url.searchParams.get("q")?.slice(0, 100)
  const cursor = url.searchParams.get("cursor")?.slice(0, 500)

  try {
    const page = await handler(providerCtx(connection, store), { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) })

    return NextResponse.json(page)
  } catch (error) {
    await flagNeedsReauthOnAuth(connection.workspaceId, connection.id, error, { store })
    return providerErrorResponse(error)
  }
})
