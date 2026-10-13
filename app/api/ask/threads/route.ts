import { NextResponse } from "next/server"

import { createThreadStore } from "@/lib/ask/thread-store"
import { withAuthz } from "@/lib/auth/authz"
import { userRequired } from "@/lib/comments/route-context"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const notImplemented = () => NextResponse.json({ error: "not_implemented" }, { status: 501 })

/**
 * GET /api/ask/threads — the caller's Ask threads; POST creates one
 * (docs/parity/m6.md, C4; owner: Package C). User principals only.
 * STEP 0 STUB: 501.
 */
export const GET = withAuthz("meeting:read", async (_request, ctx) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  return notImplemented()
})

export const POST = withAuthz("meeting:read", async (_request, ctx) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  return notImplemented()
})
