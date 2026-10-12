import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { getWorkspaceStatus } from "@/lib/ops/status"

export const GET = withAuthz("workspace:read", async (_request, ctx) => {
  const status = await getWorkspaceStatus({
    workspaceId: ctx.workspace.id,
    googleSubject: ctx.workspace.googleSubject,
    sessionEmail: ctx.user?.email,
  })

  return NextResponse.json({ sync: status.sync })
})
