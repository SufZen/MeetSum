import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { retryRealizeOSExport } from "@/lib/integrations/realizeos"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params

  try {
    const result = await retryRealizeOSExport(id)
    await recordAuditLog({
      action: "realizeos.export.retried",
      targetType: "suggested_agent_run",
      targetId: id,
      metadata: result,
    })

    return NextResponse.json(result)
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to retry RealizeOS export",
      400
    )
  }
}
