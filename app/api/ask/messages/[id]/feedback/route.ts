import { NextResponse } from "next/server"

import { createThreadStore } from "@/lib/ask/thread-store"
import { withAuthz } from "@/lib/auth/authz"
import { userRequired } from "@/lib/comments/route-context"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/ask/messages/:id/feedback `{feedback: -1 | 1 | null}` on an
 * assistant message in one of the caller's threads (docs/parity/m6.md, C4;
 * owner: Package C). User principals only. STEP 0 STUB: 501.
 */
export const POST = withAuthz<{ id: string }>("meeting:read", async (_request, ctx) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  return NextResponse.json({ error: "not_implemented" }, { status: 501 })
})
