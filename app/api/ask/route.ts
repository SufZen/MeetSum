import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/ask — AskMeetSum over a meeting, room or the workspace; SSE by
 * default, JSON for MCP/CLI (docs/parity/m6.md, C3; owner: Package C).
 * STEP 0 STUB: 501.
 */
export const POST = withAuthz("meeting:read", async (request) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.ask)

  if (rateLimit.blocked) return rateLimit.blocked

  return NextResponse.json({ error: "not_implemented" }, { status: 501, headers: rateLimit.headers })
})
