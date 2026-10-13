/**
 * GET /api/notifications?cursor&limit≤50&unread=1&locale (docs/parity/m9.md C1).
 * The caller's rows in the current workspace plus `invited` from any
 * workspace; each DTO re-checks meeting visibility. User principals only.
 */
import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { isUserPrincipal, userRequiredResponse } from "@/lib/http/m9-stubs"
import { notificationReader } from "@/lib/notifications/http"
import { NOTIFICATIONS_PAGE_MAX, listNotifications } from "@/lib/notifications/store"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withAuthz("workspace:read", async (request, ctx) => {
  if (!isUserPrincipal(ctx)) return userRequiredResponse()

  const reader = notificationReader(request, ctx)

  if (!reader) return userRequiredResponse()

  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.api)

  if (rateLimit.blocked) return rateLimit.blocked

  const params = new URL(request.url).searchParams
  const limitParam = params.get("limit")
  const limit = limitParam === null ? 20 : Number(limitParam)

  if (!Number.isInteger(limit) || limit < 1 || limit > NOTIFICATIONS_PAGE_MAX) {
    return NextResponse.json({ error: "invalid_limit" }, { status: 400, headers: rateLimit.headers })
  }

  const page = await listNotifications(reader, {
    cursor: params.get("cursor"),
    limit,
    unread: params.get("unread") === "1",
  })

  return NextResponse.json(page, { headers: { ...rateLimit.headers, "cache-control": "private, no-store" } })
})
