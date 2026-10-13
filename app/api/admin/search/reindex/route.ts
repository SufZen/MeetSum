import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/admin/search/reindex — re-index one meeting or the workspace
 * (docs/parity/m6.md, A; owner: Package A). STEP 0 STUB: 501.
 */
export const POST = withAuthz("settings:write", async () => {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
})
