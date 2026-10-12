import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { listRealizeOSExports } from "@/lib/integrations/realizeos"

export const GET = withAuthz("workspace:read", async (request, ctx) => {
  const url = new URL(request.url)
  const meetingId = url.searchParams.get("meetingId") ?? undefined
  const limit = Number(url.searchParams.get("limit") ?? 25)
  const exports = await listRealizeOSExports(ctx.workspace.id, { meetingId, limit })

  return NextResponse.json({ exports })
})
