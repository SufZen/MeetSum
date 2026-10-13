import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/[provider]/oauth/start (M8, owner: Package A). Starts the OAuth flow (signed single-use state, cookie-bound nonce, PKCE where supported).
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

/** The handler also requires `integrations:manage` for workspace providers (slack, notion, hubspot) and applies the `integrationsOAuth` rate limit. The redirect URI comes from env only, never request headers. */
export const GET = withAuthz<{ provider: string }>("integrations:connect", async () => notImplemented())
