import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { getCurrentSession } from "@/lib/auth/server"
import { getWorkspaceStatus } from "@/lib/ops/status"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const sessionEmail = await getCurrentSession()
    .then((session) => session?.email)
    .catch(() => undefined)

  return NextResponse.json({
    workspace: await getWorkspaceStatus({ sessionEmail }),
  })
}
