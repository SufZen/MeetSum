import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/connections/[id]/test (M8, owner: Package A). Test connection (a no-op provider call); audits `integration.connection.tested`.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

/** Workspace connection: also `integrations:manage`; personal: owner only. */
export const POST = withAuthz<{ id: string }>("integrations:connect", async () => notImplemented())
