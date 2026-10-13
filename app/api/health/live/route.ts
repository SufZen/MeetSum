import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"

// M10 (docs/parity/m10.md, "Health"): liveness only. No dependency calls, so a
// slow database or Redis never makes the orchestrator restart a healthy process.
export const dynamic = "force-dynamic"

export const GET = withPublicRoute(
  "Liveness probe for compose and uptime checks; no dependency calls and no tenant data.",
  async () => NextResponse.json({ status: "ok" }, { headers: { "cache-control": "no-store" } })
)
