import { NextResponse } from "next/server"

import { auditActor } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import {
  commentErrorResponse,
  commentStoreContext,
  userRequired,
} from "@/lib/comments/route-context"
import { createComment, listMeetingComments } from "@/lib/comments/store"
import type { CommentAnchor, CommentTargetType } from "@/lib/comments/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/meetings/:id/comments — threads grouped by target (with an
 * `orphaned` flag when the target is gone), reaction counts and author
 * display names. Signed-in users only.
 */
export const GET = withAuthz<{ id: string }>("meeting:read", async (_request, ctx, { params }) => {
  const { id } = await params
  const store = commentStoreContext(ctx)

  if (!store) return userRequired()

  try {
    const result = await listMeetingComments(store, id)
    const { authors } = await store.members()

    return NextResponse.json({ ...result, authors })
  } catch (error) {
    return commentErrorResponse(error)
  }
})

/**
 * POST /api/meetings/:id/comments `{targetType, targetId, body, parentId?}`
 * — viewers and up, user principals only. The body is never written to the
 * audit log.
 */
export const POST = withAuthz<{ id: string }>("comments:write", async (request, ctx, { params }) => {
  const { id } = await params
  const store = commentStoreContext(ctx)

  if (!store) return userRequired()

  const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined

  if (!body || typeof body !== "object") return jsonError("Invalid JSON body", 400)

  try {
    const comment = await createComment(store, id, {
      targetType: body.targetType as CommentTargetType,
      targetId: typeof body.targetId === "string" ? body.targetId : "",
      ...(typeof body.parentId === "string" ? { parentId: body.parentId } : {}),
      body: body.body as string,
      ...(body.anchor && typeof body.anchor === "object" ? { anchor: body.anchor as CommentAnchor } : {}),
    })

    await recordAuditLog({
      ...auditActor(ctx),
      action: "comment.created",
      targetType: "comment",
      targetId: comment.id,
      metadata: {
        meetingId: id,
        targetType: comment.targetType,
        targetId: comment.targetId,
        reply: Boolean(comment.parentId),
        mentionCount: comment.mentions.length,
      },
    })

    return NextResponse.json({ comment }, { status: 201 })
  } catch (error) {
    return commentErrorResponse(error)
  }
})
