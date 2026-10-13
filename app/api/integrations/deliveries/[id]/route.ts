import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/deliveries/[id] (M8, owner: Package A). One delivery (status polling after a manual send).
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

/** Admins, or the requester of a manual delivery. */
export const GET = withAuthz<{ id: string }>("meeting:write", async () => notImplemented())
