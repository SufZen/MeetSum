import { NextResponse } from "next/server"

import { withSession } from "@/lib/auth/authz"

/**
 * /api/integrations/[provider]/oauth/callback (M8, owner: Package A). OAuth callback: verifies the state, nonce cookie and provider, then exchanges the code.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

/** `withSession`: membership and the required permission are re-checked for `state.ws` (never taken from the state). Failures redirect with a fixed `integration_error` code. */
export const GET = withSession<{ provider: string }>(async () => notImplemented())
