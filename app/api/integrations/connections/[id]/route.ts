import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/connections/[id] (M8, owner: Package A). Update a connection's non-secret config (per-provider allowlist) or disconnect it.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

/** Workspace connection: also `integrations:manage`; personal: owner only. */
export const PATCH = withAuthz<{ id: string }>("integrations:connect", async () => notImplemented())

/** Workspace connection: also `integrations:manage`; personal: owner (admins may revoke). */
export const DELETE = withAuthz<{ id: string }>("integrations:connect", async () => notImplemented())
