import { NextResponse } from "next/server"

import { auditActor, meetingManageForbidden } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { canManageMeeting, withAuthz } from "@/lib/auth/authz"
import { clipStoreContext } from "@/lib/clips/route-context"
import { ClipNotFoundError, ClipShareError, createClipShare, getClipAccess } from "@/lib/clips/store"
import { getAppSettings } from "@/lib/settings/app-settings"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/clips/:id/share — create (or return) the clip's public link.
 * Owner-or-admin of a visible meeting; 409 `meeting_private` for a private
 * meeting. The link exposes only this clip and never changes the
 * meeting's visibility.
 */
export const POST = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const { id } = await params
  const store = clipStoreContext(ctx)
  const access = await getClipAccess(store, id)

  if (!access) return jsonError("Clip not found", 404)
  if (!canManageMeeting(ctx, access.meeting)) return meetingManageForbidden()
  if ((access.meeting.visibility ?? "workspace") === "private") {
    return NextResponse.json({ error: "meeting_private" }, { status: 409 })
  }

  const settings = await getAppSettings(ctx.workspace.id)

  if (!settings.publicSharingEnabled) {
    return jsonError("Public sharing is disabled in Settings", 403)
  }

  try {
    const share = await createClipShare(store, id)

    await recordAuditLog({
      ...auditActor(ctx),
      action: "clip.shared",
      targetType: "clip",
      targetId: id,
      metadata: { meetingId: access.clip.meetingId, shareId: share.id },
    })

    return NextResponse.json({
      url: `${new URL(request.url).origin}/share/${share.token}`,
      share: { token: share.token, createdAt: share.createdAt, expiresAt: share.expiresAt ?? null },
    })
  } catch (error) {
    if (error instanceof ClipNotFoundError) return jsonError("Clip not found", 404)
    if (error instanceof ClipShareError) {
      return NextResponse.json({ error: error.code }, { status: 409 })
    }
    throw error
  }
})
