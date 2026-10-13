import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"

/**
 * /api/email/unsubscribe (M8, owner: Package A). Email recap unsubscribe with a signed token. GET never mutates (302 to the confirmation page); POST (form or RFC 8058 one-click) records it.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

/** Rate-limited with `publicAccess`; the token is verified first. */
export const GET = withPublicRoute("Signed email unsubscribe token", async () => notImplemented())

export const POST = withPublicRoute("Signed email unsubscribe token", async () => notImplemented())
