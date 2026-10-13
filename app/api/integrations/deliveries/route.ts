import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/deliveries (M8, owner: Package A). Delivery log with filters and cursor pagination; private meetings have no title.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

export const GET = withAuthz("integrations:manage", async () => notImplemented())
