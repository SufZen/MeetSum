import { NextResponse } from "next/server"

import { workspaceErrorResponse } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { getWorkspaceStore } from "@/lib/workspaces/store"

/** DELETE /api/workspaces/current/invitations/:id — revoke a pending invitation. */
export const DELETE = withAuthz<{ id: string }>(
  "members:manage",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params

    try {
      const invitation = await getWorkspaceStore().revokeInvitation(ctx.workspace.id, id)

      await recordAuditLog({
        action: "invitation.revoked",
        ...ctx.audit,
        targetType: "invitation",
        targetId: id,
        metadata: { email: invitation.email },
      })

      return NextResponse.json({ invitation }, { headers: rateLimit.headers })
    } catch (error) {
      return workspaceErrorResponse(error)
    }
  }
)
