import { NextResponse } from "next/server"

import { jsonError, workspaceErrorResponse } from "@/lib/api/responses"
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
import { getWorkspaceStore, isInvitableRole } from "@/lib/workspaces/store"
import { isValidEmail, normalizeEmail } from "@/lib/workspaces/tokens"

/** GET /api/workspaces/current/invitations — invitations of the active workspace. */
export const GET = withAuthz("members:manage", async (_request, ctx) => {
  const invitations = await getWorkspaceStore().listInvitations(ctx.workspace.id)

  return NextResponse.json({ invitations })
})

/**
 * POST /api/workspaces/current/invitations — `{ email, role, locale? }`.
 * Emails the invite when a provider is configured; always returns
 * `inviteUrl` (send failures are stored, never fatal).
 */
export const POST = withAuthz("members:manage", async (request, ctx) => {
  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const body = await readJsonObject(request)
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : ""
  const role = body?.role ?? "member"

  if (!email || !isValidEmail(email)) return jsonError("A valid email is required", 400)
  if (!isInvitableRole(role)) {
    return jsonError('role must be "admin", "member" or "viewer"', 400)
  }

  const store = getWorkspaceStore()
  const members = await store.listMembers(ctx.workspace.id)

  if (members.some((member) => member.user.email === email)) {
    return NextResponse.json(
      { error: "already_member", message: "This person is already a member" },
      { status: 409 }
    )
  }

  try {
    const { invitation, token } = await store.createInvitation({
      workspaceId: ctx.workspace.id,
      email,
      role,
      invitedByUserId: ctx.user?.id ?? ctx.apiKey?.createdByUserId,
    })
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
      action: "invitation.created",
      ...ctx.audit,
      targetType: "invitation",
      targetId: invitation.id,
      metadata: {
        email,
        role,
        emailSent: delivery.emailSent,
        provider: delivery.provider,
      },
    })

    return NextResponse.json(
      {
        invitation: (await store.getInvitation(ctx.workspace.id, invitation.id)) ?? invitation,
        inviteUrl: delivery.inviteUrl,
        emailSent: delivery.emailSent,
        ...(delivery.error ? { emailError: delivery.error } : {}),
      },
      { status: 201, headers: rateLimit.headers }
    )
  } catch (error) {
    return workspaceErrorResponse(error)
  }
})
