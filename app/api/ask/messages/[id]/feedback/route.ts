import { NextResponse } from "next/server"

import { createThreadStore } from "@/lib/ask/thread-store"
import { withAuthz } from "@/lib/auth/authz"
import { userRequired } from "@/lib/comments/route-context"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/ask/messages/:id/feedback `{rating: 1 | -1 | null}` (legacy
 * `{feedback}` accepted) on an assistant message in one of the caller's own
 * threads (docs/parity/m6.md, C8). User principals only; another user's
 * message is a 404.
 */
export const POST = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  const { id } = await params
  const input = (await request.json().catch(() => ({}))) as { rating?: unknown; feedback?: unknown }
  const rating = input.rating !== undefined ? input.rating : input.feedback

  if (rating !== 1 && rating !== -1 && rating !== null) {
    return NextResponse.json({ error: "rating must be 1, -1 or null" }, { status: 400 })
  }
  if (!(await store.setFeedback(id, rating))) return NextResponse.json({ error: "not_found" }, { status: 404 })
  return NextResponse.json({ ok: true, rating })
})
