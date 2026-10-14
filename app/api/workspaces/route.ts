import { NextResponse } from "next/server"

import { jsonError, workspaceErrorResponse } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withSession } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import {
  isWorkspaceCreationAllowed,
  readJsonObject,
  setActiveWorkspaceCookie,
} from "@/lib/workspaces/http"
import { getWorkspaceStore } from "@/lib/workspaces/store"

/**
 * POST /api/workspaces — create a workspace owned by the caller and make it
 * active. Gated by `MEETSUM_ALLOW_WORKSPACE_CREATION` (default false).
 */
export const POST = withSession(async (request, session) => {
  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  if (!isWorkspaceCreationAllowed()) {
    return NextResponse.json({ error: "workspace_creation_disabled" }, { status: 403 })
  }

  const body = await readJsonObject(request)
  const name = typeof body?.name === "string" ? body.name.trim() : ""

  if (!name || name.length > 120) {
    return jsonError("name must be 1-120 characters", 400)
  }

  try {
    const store = getWorkspaceStore()
    const workspace = await store.createWorkspace({
      name,
      createdByUserId: session.user.id,
    })

    await recordAuditLog({
      action: "workspace.created",
      workspaceId: workspace.id,
      actor: session.user.email,
      actorUserId: session.user.id,
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { name: workspace.name },
    })

    const response = NextResponse.json(
      { workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug }, role: "owner" },
      { status: 201, headers: rateLimit.headers }
    )

    setActiveWorkspaceCookie(response, workspace.id)

    return response
  } catch (error) {
    return workspaceErrorResponse(error)
  }
})
