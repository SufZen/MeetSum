import { NextResponse } from "next/server"

import { jsonError, workspaceErrorResponse } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { can, permissionsForRole, withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { readJsonObject } from "@/lib/workspaces/http"
import { getWorkspaceStore } from "@/lib/workspaces/store"
import { normalizeEmail } from "@/lib/workspaces/tokens"

/** GET /api/workspaces/current — the active workspace and the caller's role. */
export const GET = withAuthz("workspace:read", async (_request, ctx) =>
  NextResponse.json({
    workspace: ctx.workspace,
    role: ctx.role,
    permissions: permissionsForRole(ctx.role),
  })
)

/**
 * PATCH /api/workspaces/current — `{ name?, googleSubject? }`.
 * `googleSubject` (the DWD identity MeetSum impersonates) may only be set by
 * an owner signed in as a user, and only to their own email (or cleared).
 */
export const PATCH = withAuthz("settings:write", async (request, ctx) => {
  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  const body = await readJsonObject(request)

  if (!body) return jsonError("Invalid JSON body", 400)

  const patch: { name?: string; googleSubject?: string | null } = {}

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) {
      return jsonError("name must be 1-120 characters", 400)
    }

    patch.name = body.name.trim()
  }

  if (body.googleSubject !== undefined) {
    if (ctx.principal !== "user" || !ctx.user || !can(ctx.role, "owners:manage")) {
      return NextResponse.json(
        { error: "Forbidden", permission: "owners:manage" },
        { status: 403 }
      )
    }

    if (body.googleSubject === null || body.googleSubject === "") {
      patch.googleSubject = null
    } else if (
      typeof body.googleSubject !== "string" ||
      normalizeEmail(body.googleSubject) !== normalizeEmail(ctx.user.email)
    ) {
      return NextResponse.json(
        {
          error: "google_subject_not_own_email",
          message: "The Google subject can only be set to your own email",
        },
        { status: 403 }
      )
    } else {
      patch.googleSubject = normalizeEmail(body.googleSubject)
    }
  }

  if (Object.keys(patch).length === 0) {
    return jsonError("Nothing to update", 400)
  }

  try {
    const workspace = await getWorkspaceStore().updateWorkspace(ctx.workspace.id, patch)

    await recordAuditLog({
      action: "workspace.updated",
      ...ctx.audit,
      targetType: "workspace",
      targetId: workspace.id,
      metadata: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.googleSubject !== undefined ? { googleSubject: patch.googleSubject } : {}),
      },
    })

    return NextResponse.json({ workspace }, { headers: rateLimit.headers })
  } catch (error) {
    return workspaceErrorResponse(error)
  }
})
