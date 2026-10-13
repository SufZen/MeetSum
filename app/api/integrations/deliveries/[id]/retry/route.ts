import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/deliveries/[id]/retry (M8, owner: Package A). Retry a failed, partial, or needs_reauth-skipped delivery (same idempotency key).
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

export const POST = withAuthz<{ id: string }>("integrations:manage", async () => notImplemented())
