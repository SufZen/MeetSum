/**
 * POST /api/notifications/read { ids: string[] } | { all: true }
 * (docs/parity/m9.md C1). Marks only the caller's rows. User principals only.
 */
import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { isUserPrincipal, userRequiredResponse } from "@/lib/http/m9-stubs"
import { notificationReader } from "@/lib/notifications/http"
import { countUnreadNotifications, markNotificationsRead } from "@/lib/notifications/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = withAuthz("workspace:read", async (request, ctx) => {
  if (!isUserPrincipal(ctx)) return userRequiredResponse()

  const reader = notificationReader(request, ctx)

  if (!reader) return userRequiredResponse()

  const body = (await request.json().catch(() => undefined)) as { ids?: unknown; all?: unknown } | undefined
  let input: { ids: string[] } | { all: true }

  if (body?.all === true) {
    input = { all: true }
  } else if (Array.isArray(body?.ids) && body.ids.length <= 200 && body.ids.every((id) => typeof id === "string")) {
    input = { ids: body.ids as string[] }
  } else {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 })
  }

  const updated = await markNotificationsRead(reader, input)
  const { count } = await countUnreadNotifications(reader)

  return NextResponse.json({ updated, unread: count }, { headers: { "cache-control": "private, no-store" } })
})
