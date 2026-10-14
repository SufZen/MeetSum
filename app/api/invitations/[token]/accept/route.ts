import { NextResponse } from "next/server"

import { workspaceErrorResponse } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withSession } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { setActiveWorkspaceCookie } from "@/lib/workspaces/http"
import { getWorkspaceStore } from "@/lib/workspaces/store"
import { isInvitationTokenShape } from "@/lib/workspaces/tokens"

/**
 * POST /api/invitations/:token/accept — join the invitation's workspace as
 * the signed-in user (email must match; idempotent) and make it active.
 */
export const POST = withSession<{ token: string }>(async (request, session, { params }) => {
  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const { token } = await params

  if (!isInvitationTokenShape(token)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  try {
    const { membership, workspace, invitation } = await getWorkspaceStore().acceptInvitation({
      token,
      user: session.user,
    })

    await recordAuditLog({
      action: "invitation.accepted",
      workspaceId: workspace.id,
      actor: session.user.email,
      actorUserId: session.user.id,
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { role: membership.role },
    })

    const response = NextResponse.json(
      {
        workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
        role: membership.role,
      },
      { headers: rateLimit.headers }
    )

    setActiveWorkspaceCookie(response, workspace.id)

    return response
  } catch (error) {
    return workspaceErrorResponse(error)
  }
})
