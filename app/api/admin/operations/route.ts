import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { gatherOperationalMetrics } from "@/lib/ops/operations"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

/**
 * GET /api/admin/operations
 * Operational metrics of the active workspace for the admin dashboard.
 */
export const GET = withAuthz("ops:read", async (request, ctx) => {
  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  try {
    const metrics = await gatherOperationalMetrics(ctx.workspace.id)

    return NextResponse.json(metrics, { headers: rateLimit.headers })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Failed to gather metrics",
      500
    )
  }
})
