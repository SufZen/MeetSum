import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/meetings/[id]/integrations/send (M8, owner: Package A). Manual send to a connection (`Idempotency-Key` header), 202 `{deliveryId}`.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

/** Meeting must be visible (else 404); private: `canManageMeeting`; `integrationsSend` rate limit. */
export const POST = withAuthz<{ id: string }>("meeting:write", async () => notImplemented())
