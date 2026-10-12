import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { getWorkspaceStatus } from "@/lib/ops/status"

export const GET = withAuthz("workspace:read", async (_request, ctx) =>
  NextResponse.json({
    workspace: await getWorkspaceStatus({
      sessionEmail: ctx.user?.email,
      workspaceId: ctx.workspace.id,
    }),
  })
)
