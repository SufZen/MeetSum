import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/integrations/rules/[id] (M8, owner: Package A). Update or delete a rule. Editing another admin's rule resets `include_private`.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

export const PATCH = withAuthz<{ id: string }>("integrations:manage", async () => notImplemented())

export const DELETE = withAuthz<{ id: string }>("integrations:manage", async () => notImplemented())
