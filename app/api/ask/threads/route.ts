import { NextResponse } from "next/server"

import { parseAskScope } from "@/lib/ask/http"
import { createThreadStore, InvalidThreadCursorError } from "@/lib/ask/thread-store"
import type { AskScope } from "@/lib/ask/types"
import { withAuthz } from "@/lib/auth/authz"
import { userRequired } from "@/lib/comments/route-context"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function scopeFromQuery(params: URLSearchParams): { scope?: AskScope; error?: string } {
  const kind = params.get("scope")

  if (!kind) return {}

  const parsed = parseAskScope({ kind, meetingId: params.get("meetingId"), roomId: params.get("roomId") })

  return parsed.ok ? { scope: parsed.value } : { error: parsed.error }
}

/**
 * GET /api/ask/threads — the caller's own Ask threads
 * (`?scope=meeting&meetingId=` | `room&roomId=` | `workspace`, `archived=1`,
 * `limit` ≤ 50, `cursor`); POST creates one `{scope, title?}`
 * (docs/parity/m6.md, C8). User principals only: threads are private and
 * an API key gets 403.
 */
export const GET = withAuthz("meeting:read", async (request, ctx) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  const params = new URL(request.url).searchParams
  const { scope, error } = scopeFromQuery(params)

  if (error) return NextResponse.json({ error }, { status: 400 })

  try {
    const page = await store.listThreads({
      ...(scope ? { scope } : {}),
      archived: params.get("archived") === "1" || params.get("archived") === "true",
      ...(params.get("limit") ? { limit: Number(params.get("limit")) } : {}),
      ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
    })

    return NextResponse.json(page)
  } catch (caught) {
    if (caught instanceof InvalidThreadCursorError) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 })
    throw caught
  }
})

/** Active (not archived, not deleted) threads per user: `MEETSUM_ASK_MAX_ACTIVE_THREADS` (default 500). */
function maxActiveThreads(): number {
  const value = Number(process.env.MEETSUM_ASK_MAX_ACTIVE_THREADS)

  return Number.isInteger(value) && value > 0 ? value : 500
}

export const POST = withAuthz("meeting:read", async (request, ctx) => {
  const store = createThreadStore(ctx)

  if (!store) return userRequired()

  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.threads, `threads:${ctx.workspace.id}:${ctx.user?.id}`)

  if (rateLimit.blocked) return rateLimit.blocked
  if ((await store.countActiveThreads()) >= maxActiveThreads()) {
    return NextResponse.json({ error: "thread_limit" }, { status: 409, headers: rateLimit.headers })
  }

  const input = (await request.json().catch(() => ({}))) as { scope?: unknown; title?: unknown }
  const scope = parseAskScope(input.scope)

  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: 400 })
  if (input.title !== undefined && input.title !== null && typeof input.title !== "string") {
    return NextResponse.json({ error: "title must be a string" }, { status: 400 })
  }

  const thread = await store.createThread({ scope: scope.value, title: typeof input.title === "string" ? input.title : null })

  if (!thread) return NextResponse.json({ error: "not_found" }, { status: 404 })
  return NextResponse.json({ thread }, { status: 201 })
})
