import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"
import { limitHealthProbe } from "@/lib/health/rate-limit"
import { getReadiness } from "@/lib/health/ready"

// M10 (docs/parity/m10.md, "Health"): 200 or 503 with `{ status, checks }`
// (database, redis, storage, migrations: "ok" | "fail" | "skip"). Never error
// text, hosts, versions or tenant data.
export const dynamic = "force-dynamic"

export const GET = withPublicRoute(
  "Readiness probe for compose, deploy and uptime checks; reports only ok/fail/skip per dependency and no tenant data.",
  async (request) => {
    const limited = await limitHealthProbe(request)

    if (limited) return limited

    const report = await getReadiness()

    return NextResponse.json(report, {
      status: report.status === "ok" ? 200 : 503,
      headers: { "cache-control": "no-store" },
    })
  }
)
