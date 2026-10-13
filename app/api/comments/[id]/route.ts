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
import { deleteComment, editComment, resolveComment } from "@/lib/comments/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * PATCH /api/comments/:id — `{body}` edits (author only) or `{resolved}`
 * resolves / reopens the thread (member and up).
 */
export const PATCH = withAuthz<{ id: string }>("comments:write", async (request, ctx, { params }) => {
  const { id } = await params
  const store = commentStoreContext(ctx)

  if (!store) return userRequired()

  const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined

  if (!body || typeof body !== "object") return jsonError("Invalid JSON body", 400)

  try {
    if (typeof body.resolved === "boolean") {
      const comment = await resolveComment(store, id, body.resolved)

      await recordAuditLog({
        ...auditActor(ctx),
        action: "comment.resolved",
        targetType: "comment",
        targetId: id,
        metadata: { meetingId: comment.meetingId, resolved: body.resolved },
      })

      return NextResponse.json({ comment })
    }

    if (body.body === undefined) return jsonError("Provide body or resolved", 400)

    const comment = await editComment(store, id, body.body as string)

    return NextResponse.json({ comment })
  } catch (error) {
    return commentErrorResponse(error)
  }
})

/** DELETE /api/comments/:id — the author, or an admin/owner. */
export const DELETE = withAuthz<{ id: string }>("comments:write", async (_request, ctx, { params }) => {
  const { id } = await params
  const store = commentStoreContext(ctx)

  if (!store) return userRequired()

  try {
    if (!(await deleteComment(store, id))) return jsonError("Comment not found", 404)

    await recordAuditLog({
      ...auditActor(ctx),
      action: "comment.deleted",
      targetType: "comment",
      targetId: id,
    })

    return NextResponse.json({ deleted: true })
  } catch (error) {
    return commentErrorResponse(error)
  }
})
