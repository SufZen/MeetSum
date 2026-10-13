import { NextResponse } from "next/server"

import { askJsonBody, askResultStatus, parseAskRequest, wantsJson } from "@/lib/ask/http"
import { askOnce, askStream, checkAskScope } from "@/lib/ask/service"
import { withAuthz } from "@/lib/auth/authz"
import { sseResponse } from "@/lib/http/sse"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/ask — AskMeetSum over a meeting, room or every visible meeting
 * (docs/parity/m6.md, C8). Body `AskRequest` (question 1-2000 characters).
 * `Accept: text/event-stream` (default) streams SSE events
 * (`thread`, `context`, `delta`*, then `done` or `error`);
 * `Accept: application/json` returns `AskJsonResponse` (MCP, CLI).
 * API-key principals are stateless (`persist:false`). An invisible meeting
 * or a foreign room is a 404. The per-principal `ask` limit is enforced in
 * the service (shared with every ask entry point); this route also applies
 * the per-IP limit. The question is never audited or logged.
 */
export const POST = withAuthz("meeting:read", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.ask)

  if (rateLimit.blocked) return rateLimit.blocked

  const parsed = parseAskRequest(await request.json().catch(() => undefined))

  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: rateLimit.headers })

  const askRequest = ctx.principal === "user" ? parsed.value : { ...parsed.value, persist: false }

  if (!(await checkAskScope(ctx, askRequest.scope)).ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: rateLimit.headers })
  }

  if (wantsJson(request)) {
    const result = await askOnce(ctx, askRequest, request.signal)

    return NextResponse.json(askJsonBody(result), { status: askResultStatus(result), headers: rateLimit.headers })
  }

  return sseResponse(askStream(ctx, askRequest, request.signal), {
    signal: request.signal,
    headers: rateLimit.headers,
  })
})
