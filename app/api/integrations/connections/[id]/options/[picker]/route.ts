import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/connections/[id]/options/[picker] (M8, owner: Package A). Destination picker (channels, databases, deals...), searchable and paginated.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

/** Rule pickers need `integrations:manage`; manual-send pickers need `allowManualSend`; personal: owner. */
export const GET = withAuthz<{ id: string; picker: string }>("meeting:write", async () => notImplemented())
