import { NextResponse } from "next/server"

import { jsonError, workspaceErrorResponse } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { can, withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { readJsonObject } from "@/lib/workspaces/http"
import { getWorkspaceStore, isWorkspaceRole } from "@/lib/workspaces/store"

function forbidden(permission: string) {
  return NextResponse.json({ error: "Forbidden", permission }, { status: 403 })
}

/**
 * PATCH /api/workspaces/current/members/:userId — `{ role }`.
 * Changes involving the owner role (promoting to or demoting from owner)
 * need `owners:manage`. The last owner can never be demoted.
 */
export const PATCH = withAuthz<{ userId: string }>(
  "members:manage",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

    if (rateLimit.blocked) return rateLimit.blocked

    const { userId } = await params
    const body = await readJsonObject(request)
    const role = body?.role

    if (!isWorkspaceRole(role)) {
      return jsonError('role must be "owner", "admin", "member" or "viewer"', 400)
    }

    const store = getWorkspaceStore()
    const target = await store.getMembership(ctx.workspace.id, userId)

    if (!target) return jsonError("Member not found", 404)
    if ((target.role === "owner" || role === "owner") && !can(ctx.role, "owners:manage")) {
      return forbidden("owners:manage")
    }
    if (target.role === role) {
      return NextResponse.json({ member: target }, { headers: rateLimit.headers })
    }

    try {
      const member = await store.setMemberRole({
        workspaceId: ctx.workspace.id,
        userId,
        role,
      })

      await recordAuditLog({
        action: "member.role_changed",
        ...ctx.audit,
        targetType: "user",
        targetId: userId,
        metadata: { from: target.role, to: role },
      })

      return NextResponse.json({ member }, { headers: rateLimit.headers })
    } catch (error) {
      return workspaceErrorResponse(error)
    }
  }
)

/**
 * DELETE /api/workspaces/current/members/:userId — remove a member
 * (`members:manage`; owners need `owners:manage`) or leave (own user id,
 * any role). The last owner can neither leave nor be removed.
 */
export const DELETE = withAuthz<{ userId: string }>(
  "workspace:read",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

    if (rateLimit.blocked) return rateLimit.blocked

    const { userId } = await params
    const isSelf = ctx.principal === "user" && ctx.user?.id === userId

    if (!isSelf && !can(ctx.role, "members:manage")) return forbidden("members:manage")

    const store = getWorkspaceStore()
    const target = await store.getMembership(ctx.workspace.id, userId)

    if (!target) return jsonError("Member not found", 404)
    if (!isSelf && target.role === "owner" && !can(ctx.role, "owners:manage")) {
      return forbidden("owners:manage")
    }

    try {
      await store.removeMember({ workspaceId: ctx.workspace.id, userId })

      await recordAuditLog({
        action: isSelf ? "member.left" : "member.removed",
        ...ctx.audit,
        targetType: "user",
        targetId: userId,
        metadata: { role: target.role },
      })

      return NextResponse.json({ removed: true, left: isSelf }, { headers: rateLimit.headers })
    } catch (error) {
      return workspaceErrorResponse(error)
    }
  }
)
