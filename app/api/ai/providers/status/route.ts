import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { getProviderStatus } from "@/lib/ops/status"

export const GET = withAuthz("workspace:read", async () =>
  NextResponse.json({ providers: getProviderStatus() })
)
