import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { isFakeMode } from "@/lib/integrations/core/http"
import { listProviders } from "@/lib/integrations/core/registry"
import type { ProviderInfo } from "@/lib/integrations/core/types"

/**
 * GET /api/integrations/providers (M8 A1) → `[{id, scope, configured, fake}]`
 * for the UI. Never includes client ids or secrets.
 */
export const GET = withAuthz("workspace:read", async () => {
  const fake = isFakeMode()
  const providers: ProviderInfo[] = listProviders().map((provider) => {
    let configured = false

    try {
      configured = provider.configured()
    } catch {
      configured = false
    }

    return { id: provider.id, scope: provider.scope, configured, fake }
  })

  return NextResponse.json({ providers })
})
