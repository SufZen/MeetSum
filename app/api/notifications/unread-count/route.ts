/**
 * GET /api/notifications/unread-count (weak ETag; docs/parity/m9.md C1).
 * Polled by the bell; answers 304 while the count and the newest unread row
 * are unchanged. User principals only.
 */
import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { isUserPrincipal, userRequiredResponse } from "@/lib/http/m9-stubs"
import { notificationReader } from "@/lib/notifications/http"
import { countUnreadNotifications } from "@/lib/notifications/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = withAuthz("workspace:read", async (request, ctx) => {
  if (!isUserPrincipal(ctx)) return userRequiredResponse()

  const reader = notificationReader(request, ctx)

  if (!reader) return userRequiredResponse()

  const { count, latestId } = await countUnreadNotifications(reader)
  const etag = `W/"${count}-${latestId ?? "none"}"`
  const headers = { etag, "cache-control": "private, no-cache" }

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers })
  }

  return NextResponse.json({ count }, { headers })
})
