import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"
import { limitHealthProbe } from "@/lib/health/rate-limit"

// M10 (docs/parity/m10.md, "Health"): liveness only. No dependency calls, so a
// slow database or Redis never makes the orchestrator restart a healthy process.
// The per-IP limit is the in-process limiter (never Redis).
export const dynamic = "force-dynamic"

export const GET = withPublicRoute(
  "Liveness probe for compose and uptime checks; no dependency calls and no tenant data.",
  async (request) => {
    const limited = await limitHealthProbe(request)

    if (limited) return limited

    return NextResponse.json({ status: "ok" }, { headers: { "cache-control": "no-store" } })
  }
)
