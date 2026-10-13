import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/search/facets — filter values from visible meetings
 * (docs/parity/m6.md, B7; owner: Package B). STEP 0 STUB: 501.
 */
export const GET = withAuthz("meeting:read", async () => {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
})
