import { NextResponse } from "next/server"

import { createThreadStore } from "@/lib/ask/thread-store"
import { withAuthz } from "@/lib/auth/authz"
import { userRequired } from "@/lib/comments/route-context"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const notImplemented = () => NextResponse.json({ error: "not_implemented" }, { status: 501 })

/**
 * GET / PATCH / DELETE /api/ask/threads/:id — one of the caller's threads
 * (docs/parity/m6.md, C4; owner: Package C). User principals only; another
 * user's thread is a 404. STEP 0 STUB: 501.
 */
export const GET = withAuthz<{ id: string }>("meeting:read", async (_request, ctx) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  return notImplemented()
})

export const PATCH = withAuthz<{ id: string }>("meeting:read", async (_request, ctx) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  return notImplemented()
})

export const DELETE = withAuthz<{ id: string }>("meeting:read", async (_request, ctx) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  return notImplemented()
})
