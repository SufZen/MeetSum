import { NextResponse } from "next/server"

import { auditActor } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { normalizeClipTitle } from "@/lib/clips/range"
import { canManageClip, clipStoreContext } from "@/lib/clips/route-context"
import { ClipNotFoundError, deleteClip, getClipAccess, renameClip } from "@/lib/clips/store"
import { toClipWire } from "@/lib/clips/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function clipNotFound() {
  return jsonError("Clip not found", 404)
}

function clipManageForbidden() {
  return NextResponse.json({ error: "Forbidden", reason: "clip_manage_required" }, { status: 403 })
}

/** GET /api/clips/:id — a clip of a meeting the caller can see. */
export const GET = withAuthz<{ id: string }>("meeting:read", async (_request, ctx, { params }) => {
  const { id } = await params
  const access = await getClipAccess(clipStoreContext(ctx), id)

  if (!access) return clipNotFound()

  return NextResponse.json({
    clip: toClipWire(access.clip, canManageClip(ctx, access.clip, access.meeting)),
  })
})

/** PATCH /api/clips/:id `{title}` — rename (author or meeting manager). */
export const PATCH = withAuthz<{ id: string }>("meeting:write", async (request, ctx, { params }) => {
  const { id } = await params
  const store = clipStoreContext(ctx)
  const access = await getClipAccess(store, id)

  if (!access) return clipNotFound()
  if (!canManageClip(ctx, access.clip, access.meeting)) return clipManageForbidden()

  const body = (await request.json().catch(() => ({}))) as { title?: unknown }
  const title = normalizeClipTitle(body?.title)

  if (!title) return jsonError("title is required", 400)

  try {
    const clip = await renameClip(store, id, title)

    await recordAuditLog({
      ...auditActor(ctx),
      action: "clip.updated",
      targetType: "clip",
      targetId: id,
      metadata: { meetingId: clip.meetingId, fields: ["title"] },
    })

    return NextResponse.json({ clip: toClipWire(clip, true) })
  } catch (error) {
    if (error instanceof ClipNotFoundError) return clipNotFound()
    throw error
  }
})

/** DELETE /api/clips/:id — soft delete; revokes the clip's share links. */
export const DELETE = withAuthz<{ id: string }>("meeting:write", async (_request, ctx, { params }) => {
  const { id } = await params
  const store = clipStoreContext(ctx)
  const access = await getClipAccess(store, id)

  if (!access) return clipNotFound()
  if (!canManageClip(ctx, access.clip, access.meeting)) return clipManageForbidden()
  if (!(await deleteClip(store, id))) return clipNotFound()

  await recordAuditLog({
    ...auditActor(ctx),
    action: "clip.deleted",
    targetType: "clip",
    targetId: id,
    metadata: { meetingId: access.clip.meetingId },
  })

  return NextResponse.json({ deleted: true })
})
