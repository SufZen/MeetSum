import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/meetings/[id]/integration-prefs (M8, owner: Package A). Per-meeting integration prefs `{allowPrivatePush, emailRecap}`.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

/** Meeting must be visible. */
export const GET = withAuthz<{ id: string }>("meeting:read", async () => notImplemented())

/** Visible; `allowPrivatePush` owner only; `emailRecap` on a private meeting needs `canManageMeeting`. */
export const PUT = withAuthz<{ id: string }>("meeting:write", async () => notImplemented())
