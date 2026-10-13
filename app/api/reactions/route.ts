import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import {
  commentErrorResponse,
  commentStoreContext,
  userRequired,
} from "@/lib/comments/route-context"
import { toggleReaction } from "@/lib/comments/store"
import type { ReactionEmoji, ReactionTargetType } from "@/lib/comments/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/reactions `{meetingId, targetType, targetId, emoji}` — toggles
 * the caller's reaction (allowlist 👍 ❤️ 🎯 ✅ ❓ 😂). Viewers and up, user
 * principals only.
 */
export const POST = withAuthz("comments:write", async (request, ctx) => {
  const store = commentStoreContext(ctx)

  if (!store) return userRequired()

  const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined

  if (!body || typeof body !== "object" || typeof body.meetingId !== "string") {
    return jsonError("meetingId, targetType, targetId and emoji are required", 400)
  }

  try {
    const result = await toggleReaction(store, {
      meetingId: body.meetingId,
      targetType: body.targetType as ReactionTargetType,
      targetId: typeof body.targetId === "string" ? body.targetId : "",
      emoji: body.emoji as ReactionEmoji,
    })

    return NextResponse.json(result)
  } catch (error) {
    return commentErrorResponse(error)
  }
})
