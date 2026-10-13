import { NextResponse } from "next/server"

import { withPublicRoute } from "@/lib/auth/authz"

// M10 Step 0 stub. Package B implements the readiness checks (database,
// redis, storage, migrations; 200 or 503 with `{ status, checks }`, never
// error text, hosts or tenant data) per docs/parity/m10.md, "Health".
export const dynamic = "force-dynamic"

export const GET = withPublicRoute(
  "Readiness probe for compose, deploy and uptime checks; reports only ok/fail/skip per dependency and no tenant data.",
  async () =>
    NextResponse.json(
      { status: "not_implemented" },
      { status: 501, headers: { "cache-control": "no-store" } }
    )
)
