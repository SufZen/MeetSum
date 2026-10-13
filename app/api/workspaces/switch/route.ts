import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withSession } from "@/lib/auth/authz"
import { readJsonObject, setActiveWorkspaceCookie } from "@/lib/workspaces/http"
import { getWorkspaceStore } from "@/lib/workspaces/store"

/**
 * POST /api/workspaces/switch — body `{ workspaceId }`. Sets the active
 * workspace cookie (httpOnly, lax) and the user's default workspace. Only
 * workspaces the caller is a member of; others are 404 (no existence leak).
 */
export const POST = withSession(async (request, session) => {
  const body = await readJsonObject(request)
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : ""

  if (!workspaceId) return jsonError("workspaceId is required", 400)

  const store = getWorkspaceStore()
  const membership = await store.getMembership(workspaceId, session.user.id)
  const workspace = membership ? await store.getWorkspace(workspaceId) : undefined

  if (!membership || !workspace) return jsonError("Workspace not found", 404)

  await store.setDefaultWorkspace(session.user.id, workspaceId)

  const response = NextResponse.json({
    activeWorkspaceId: workspaceId,
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    role: membership.role,
  })

  setActiveWorkspaceCookie(response, workspaceId)

  return response
})
