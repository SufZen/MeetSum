import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { getWorkspaceStore } from "@/lib/workspaces/store"
import { isInvitationTokenShape } from "@/lib/workspaces/tokens"

/**
 * GET /api/invitations/:token — what an invite link points at (for the
 * invite page before sign-in). Possession of the token is the credential.
 */
export const GET = withPublicRoute<{ token: string }>(
  "Invitation preview for the token holder before sign-in",
  async (request, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.publicAccess)

    if (rateLimit.blocked) return rateLimit.blocked

    const { token } = await params
    const notFound = NextResponse.json(
      { error: "invitation_not_found" },
      { status: 404, headers: rateLimit.headers }
    )

    if (!isInvitationTokenShape(token)) return notFound

    const found = await getWorkspaceStore().findInvitationByToken(token)

    if (!found) return notFound

    return NextResponse.json(
      {
        invitation: {
          email: found.invitation.email,
          role: found.invitation.role,
          status: found.invitation.status,
          expiresAt: found.invitation.expiresAt,
        },
        workspace: { id: found.workspace.id, name: found.workspace.name },
      },
      { headers: { ...rateLimit.headers, "Cache-Control": "no-store" } }
    )
  }
)
