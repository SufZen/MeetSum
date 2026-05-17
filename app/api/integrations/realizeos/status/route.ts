import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { getRealizeOSStatus } from "@/lib/integrations/realizeos"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const status = await getRealizeOSStatus()

  return NextResponse.json({ status })
}
