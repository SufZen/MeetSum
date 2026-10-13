import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/search?q=&…filters — hybrid search over visible meetings
 * (docs/parity/m6.md, B7; owner: Package B). STEP 0 STUB: 501.
 */
export const GET = withAuthz("meeting:read", async (request) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.search)

  if (rateLimit.blocked) return rateLimit.blocked

  return NextResponse.json({ error: "not_implemented" }, { status: 501, headers: rateLimit.headers })
})
