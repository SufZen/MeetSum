import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { listRealizeOSExports } from "@/lib/integrations/realizeos"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const url = new URL(request.url)
  const meetingId = url.searchParams.get("meetingId") ?? undefined
  const limit = Number(url.searchParams.get("limit") ?? 25)
  const exports = await listRealizeOSExports({ meetingId, limit })

  return NextResponse.json({ exports })
}
