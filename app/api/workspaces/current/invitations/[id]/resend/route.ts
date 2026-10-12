import { NextResponse } from "next/server"

import { workspaceErrorResponse } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { getAppSettings } from "@/lib/settings/app-settings"
import { readJsonObject } from "@/lib/workspaces/http"
import {
  deliverInvitation,
  resolveAppOrigin,
  toInvitationLocale,
} from "@/lib/workspaces/invitations"
import { getWorkspaceStore } from "@/lib/workspaces/store"

/**
 * POST /api/workspaces/current/invitations/:id/resend — issue a fresh token
 * (the old link stops working), extend the expiry and email it again.
 */
export const POST = withAuthz<{ id: string }>(
  "members:manage",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const body = await readJsonObject(request)
    const store = getWorkspaceStore()

    try {
      const { invitation, token } = await store.rotateInvitationToken(ctx.workspace.id, id)
      const locale =
        toInvitationLocale(body?.locale) ??
        toInvitationLocale((await getAppSettings(ctx.workspace.id)).defaultLocale) ??
        "en"
      const delivery = await deliverInvitation({
        store,
        invitation,
        token,
        workspace: ctx.workspace,
        inviterName: ctx.user?.name ?? ctx.user?.email,
        locale,
        origin: resolveAppOrigin(request),
      })

      await recordAuditLog({
        action: "invitation.resent",
        ...ctx.audit,
        targetType: "invitation",
        targetId: id,
        metadata: { email: invitation.email, emailSent: delivery.emailSent },
      })

      return NextResponse.json(
        {
          invitation: (await store.getInvitation(ctx.workspace.id, id)) ?? invitation,
          inviteUrl: delivery.inviteUrl,
          emailSent: delivery.emailSent,
          ...(delivery.error ? { emailError: delivery.error } : {}),
        },
        { headers: rateLimit.headers }
      )
    } catch (error) {
      return workspaceErrorResponse(error)
    }
  }
)
