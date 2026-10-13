/**
 * POST /api/me/invitations/[id]/accept: joins the invitation's workspace as
 * the signed-in user (docs/parity/m9.md C1). The session email must equal the
 * invitation email (403 `email_mismatch`); the M2 accept transaction runs
 * unchanged; audited; the joined workspace becomes active.
 * withSession rejects API keys.
 */
import { NextResponse } from "next/server"

import { workspaceErrorResponse } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withSession } from "@/lib/auth/authz"
import { findMyInvitationWorkspace } from "@/lib/notifications/invitations"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { acceptInvitationById } from "@/lib/workspaces/invitations"
import { setActiveWorkspaceCookie } from "@/lib/workspaces/http"
import { getWorkspaceStore } from "@/lib/workspaces/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const INVITATION_ID = /^[A-Za-z0-9_-]{1,80}$/

export const POST = withSession<{ id: string }>(async (request, session, { params }) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const { id } = await params
  const workspaceId = INVITATION_ID.test(id) ? await findMyInvitationWorkspace(session.user, id) : undefined

  if (!workspaceId) return NextResponse.json({ error: "not_found" }, { status: 404, headers: rateLimit.headers })

  try {
    const { membership, workspace, invitation } = await acceptInvitationById(getWorkspaceStore(), {
      workspaceId,
      invitationId: id,
      user: session.user,
    })

    await recordAuditLog({
      action: "invitation.accepted",
      workspaceId: workspace.id,
      actor: session.user.email,
      actorUserId: session.user.id,
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { role: membership.role, via: "in_app" },
    })

    const response = NextResponse.json(
      { workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug }, role: membership.role },
      { headers: rateLimit.headers }
    )

    setActiveWorkspaceCookie(response, workspace.id)

    return response
  } catch (error) {
    return workspaceErrorResponse(error)
  }
})
