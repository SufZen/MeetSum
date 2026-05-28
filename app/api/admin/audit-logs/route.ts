import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { listAuditLogs, type AuditAction } from "@/lib/audit"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const url = new URL(request.url)
  const action = url.searchParams.get("action") as AuditAction | undefined
  const targetType = url.searchParams.get("targetType") ?? undefined
  const targetId = url.searchParams.get("targetId") ?? undefined
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200)

  const logs = await listAuditLogs({ action, targetType, targetId, limit })

  return NextResponse.json({ logs })
}
