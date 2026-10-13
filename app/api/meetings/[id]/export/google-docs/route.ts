import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

/**
 * /api/meetings/[id]/export/google-docs (M8, owner: Package C). Export to Google Docs (create, or update the tracked doc).
 *
 * Step 0 stub: answers 501 behind its final guard (docs/parity/m8.md,
 * "Route to permission map").
 */
function notImplemented() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
}

/** Meeting must be visible; `exports` rate limit. */
export const POST = withAuthz<{ id: string }>("meeting:read", async () => notImplemented())
