import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { searchContextFrom, searchRateLimitKey, searchRateLimitUnavailable } from "@/lib/search/context"
import { InvalidCursorError } from "@/lib/search/cursor"
import { SearchUnavailableError } from "@/lib/search/errors"
import { SearchRequestError, parseSearchParams } from "@/lib/search/filters"
import { searchWorkspace } from "@/lib/search/service"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "search" })

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/search — hybrid search over the caller's visible meetings
 * (docs/parity/m6.md, B7).
 *
 * Params: `q` (≤ 300 chars), `from`, `to` (ISO dates, inclusive),
 * `participant`, `speaker`, `room`, `tag`, `language` (he|en|mixed), `type`,
 * `source`, `kind` (transcript|summary|item|action_item|chapter|meta),
 * `meetingId` (all repeatable), `group` (meeting|chunk), `limit` (≤ 25
 * groups / ≤ 50 chunks), `hits` (≤ 10 per meeting), `cursor`.
 */
export const GET = withAuthz("meeting:read", async (request, ctx) => {
  const limitKey = searchRateLimitKey(ctx)

  if (!limitKey) return searchRateLimitUnavailable()

  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.search, limitKey)

  if (rateLimit.blocked) return rateLimit.blocked

  try {
    const params = parseSearchParams(new URL(request.url).searchParams)
    const response = await searchWorkspace(searchContextFrom(ctx), params, { signal: request.signal })

    return NextResponse.json(response, { headers: rateLimit.headers })
  } catch (error) {
    if (error instanceof SearchRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: rateLimit.headers })
    }
    if (error instanceof InvalidCursorError) {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400, headers: rateLimit.headers })
    }
    if (error instanceof SearchUnavailableError) {
      return NextResponse.json({ error: "Search unavailable" }, { status: 503, headers: rateLimit.headers })
    }
    log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "[search] failed:")

    return NextResponse.json({ error: "Search failed" }, { status: 500, headers: rateLimit.headers })
  }
})
