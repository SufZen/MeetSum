import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/rules (M8, owner: Package A). Integration rules (admins only, workspace scope).
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

export const GET = withAuthz("integrations:manage", async () => notImplemented())

/** `integrationsWrite` rate limit; DB caps answer 409. */
export const POST = withAuthz("integrations:manage", async () => notImplemented())
