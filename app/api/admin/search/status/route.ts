import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/admin/search/status — capabilities, index coverage and the
 * active embedding key (docs/parity/m6.md, A; owner: Package A).
 * STEP 0 STUB: 501.
 */
export const GET = withAuthz("ops:read", async () => {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
})
