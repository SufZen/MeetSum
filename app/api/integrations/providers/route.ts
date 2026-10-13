import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/providers (M8, owner: Package A). Providers for the settings page: `[{id, scope, configured, fake}]`, never client ids.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

export const GET = withAuthz("workspace:read", async () => notImplemented())
