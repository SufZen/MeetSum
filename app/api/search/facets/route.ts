import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { searchContextFrom, searchRateLimitKey, searchRateLimitUnavailable } from "@/lib/search/context"
import { listSearchFacets } from "@/lib/search/facets"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "search/facets" })

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/search/facets — filter values (people, speakers, rooms, tags,
 * languages, meeting types, sources) from the caller's visible meetings
 * (docs/parity/m6.md, B7).
 */
export const GET = withAuthz("meeting:read", async (request, ctx) => {
  // Same bucket as search: facets run aggregate queries.
  const limitKey = searchRateLimitKey(ctx)

  if (!limitKey) return searchRateLimitUnavailable()

  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.search, limitKey)

  if (rateLimit.blocked) return rateLimit.blocked

  try {
    // Body is the frozen `SearchFacets` contract itself.
    return NextResponse.json(await listSearchFacets(searchContextFrom(ctx)), { headers: rateLimit.headers })
  } catch (error) {
    log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "[search] facets failed:")

    return NextResponse.json({ error: "Facets failed" }, { status: 500, headers: rateLimit.headers })
  }
})
