import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { getWorkspaceStore } from "@/lib/workspaces/store"

/** GET /api/workspaces/current/members — members of the active workspace. */
export const GET = withAuthz("workspace:read", async (_request, ctx) => {
  const members = await getWorkspaceStore().listMembers(ctx.workspace.id)

  return NextResponse.json({
    members: members.map((member) => ({
      userId: member.userId,
      email: member.user.email,
      name: member.user.name ?? null,
      picture: member.user.picture ?? null,
      role: member.role,
      createdAt: member.createdAt ?? null,
    })),
  })
})
