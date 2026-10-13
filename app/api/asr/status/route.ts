import { NextResponse } from "next/server"

import { getAsrRouterStatus } from "@/lib/ai/asr"
import { withAuthz } from "@/lib/auth/authz"

/**
 * GET /api/asr/status — ASR provider chains with per-provider configuration,
 * health and circuit-breaker state. Never includes keys.
 */
export const GET = withAuthz("ops:read", async () => {
  const status = await getAsrRouterStatus()

  return NextResponse.json(status)
})
