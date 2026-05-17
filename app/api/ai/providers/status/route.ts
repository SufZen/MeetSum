import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { getProviderStatus } from "@/lib/ops/status"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  return NextResponse.json({ providers: getProviderStatus() })
}
