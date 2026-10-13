import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/connections (M8, owner: Package A). Workspace connections (label, status) plus my personal ones; admins also see others' personal connections (label and status only).
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

export const GET = withAuthz("integrations:connect", async () => notImplemented())
