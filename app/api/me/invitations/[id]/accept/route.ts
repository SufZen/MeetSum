/**
 * POST /api/me/invitations/[id]/accept: joins the invitation's workspace as
 * the signed-in user (docs/parity/m9.md C1). Only a pending, unexpired
 * invitation addressed to the session email can be accepted; anything else
 * (unknown, someone else's, expired, revoked, already used) gets the same
 * 404, so ids cannot be enumerated. Single-use (the M2 accept transaction
 * re-checks pending under a row lock); audited; the joined workspace becomes
 * active. withSession rejects API keys.
 */
import { NextResponse } from "next/server"

import { recordAuditLog } from "@/lib/audit"
import { withSession } from "@/lib/auth/authz"
import { findMyInvitationWorkspace } from "@/lib/notifications/invitations"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { acceptInvitationById } from "@/lib/workspaces/invitations"
import { setActiveWorkspaceCookie } from "@/lib/workspaces/http"
import { WorkspaceStoreError, getWorkspaceStore } from "@/lib/workspaces/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const INVITATION_ID = /^[A-Za-z0-9_-]{1,80}$/

function notFound(headers: Record<string, string>): Response {
  return NextResponse.json({ error: "not_found" }, { status: 404, headers })
}

export const POST = withSession<{ id: string }>(async (request, session, { params }) => {
  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const { id } = await params
  const store = getWorkspaceStore()
  const workspaceId = INVITATION_ID.test(id) ? await findMyInvitationWorkspace(session.user, id, store) : undefined

  if (!workspaceId) return notFound(rateLimit.headers)

  try {
    const { membership, workspace, invitation } = await acceptInvitationById(store, {
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
    // A concurrent accept, revoke or expiry between the lookup and the
    // transaction: same answer as an unknown id.
    if (error instanceof WorkspaceStoreError) return notFound(rateLimit.headers)

    throw error
  }
})
