/**
 * GET /api/analytics/overview?from&to|range&interval&scope&roomId&tz
 * (docs/parity/m9.md C2). `meeting:read`, user principals only (API keys →
 * 403 `user_required`). Aggregates only meetings visible to the caller; the
 * per-member breakdown is for owners and admins; a room of another workspace
 * is 404; ranges above 366 days are 400.
 */
import { NextResponse } from "next/server"

import { parseAnalyticsQuery } from "@/lib/analytics/dashboard/query"
import { getAnalyticsOverview } from "@/lib/analytics/dashboard/service"
import { withAuthz } from "@/lib/auth/authz"
import { isUserPrincipal, userRequiredResponse } from "@/lib/http/m9-stubs"
import { resolveRequesterTimeZone } from "@/lib/analytics/dashboard/time-zone"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withAuthz("meeting:read", async (request, ctx) => {
  if (!isUserPrincipal(ctx)) return userRequiredResponse()
  if (!ctx.user) return userRequiredResponse()

  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

  if (rateLimit.blocked) return rateLimit.blocked

  const parsed = parseAnalyticsQuery(new URL(request.url).searchParams, {
    timeZone: await resolveRequesterTimeZone(),
  })

  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: rateLimit.headers })

  const result = await getAnalyticsOverview(
    { workspaceId: ctx.workspace.id, userId: ctx.user.id, email: ctx.user.email, role: ctx.role },
    parsed.query
  )

  if (!result.ok) return NextResponse.json({ error: "not_found" }, { status: 404, headers: rateLimit.headers })

  return NextResponse.json(result.overview, {
    headers: { ...rateLimit.headers, "cache-control": "private, no-store" },
  })
})
