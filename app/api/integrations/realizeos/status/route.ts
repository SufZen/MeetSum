import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { getRealizeOSStatus } from "@/lib/integrations/realizeos"

export const GET = withAuthz("workspace:read", async () => {
  const status = await getRealizeOSStatus()

  return NextResponse.json({ status })
})
