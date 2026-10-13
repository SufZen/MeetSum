import { NextResponse } from "next/server"

import {
  permissionsForRole,
  selectActiveMembership,
  withSession,
} from "@/lib/auth/authz"
import { readRequestCookie } from "@/lib/auth/session"
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspaces/constants"
import { getWorkspaceStore } from "@/lib/workspaces/store"

/**
 * GET /api/me — signed-in user, their workspaces, the active one and the
 * permissions they hold there. Works without any membership (empty list).
 */
export const GET = withSession(async (request, session) => {
  const store = getWorkspaceStore()
  const [user, memberships] = await Promise.all([
    store.getUserById(session.user.id),
    store.listMembershipsForUser(session.user.id),
  ])
  const active = selectActiveMembership(memberships, {
    cookieWorkspaceId: readRequestCookie(request, ACTIVE_WORKSPACE_COOKIE),
    defaultWorkspaceId: user?.defaultWorkspaceId,
  })

  return NextResponse.json({
    user: session.user,
    workspaces: memberships.map((membership) => ({
      id: membership.workspaceId,
      name: membership.workspace.name,
      role: membership.role,
    })),
    activeWorkspaceId: active?.workspaceId ?? null,
    role: active?.role ?? null,
    permissions: active ? permissionsForRole(active.role) : [],
  })
})
