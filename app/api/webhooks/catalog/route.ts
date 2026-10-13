import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/webhooks/catalog (M8, owner: Package C). Webhook event catalog `{version, events: [{name, versions, description, example, schemaUrl}]}`.
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

export const GET = withAuthz("webhooks:manage", async () => notImplemented())
