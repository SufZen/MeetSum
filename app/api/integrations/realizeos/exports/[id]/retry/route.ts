import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { toRepoScope, withAuthz } from "@/lib/auth/authz"
import {
  RealizeOSExportNotFoundError,
  RealizeOSPrivateMeetingError,
  retryRealizeOSExport,
} from "@/lib/integrations/realizeos"

export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (_request, ctx, { params }) => {
    const { id } = await params

    try {
      const result = await retryRealizeOSExport(toRepoScope(ctx), id)
      await recordAuditLog({
        ...ctx.audit,
        action: "realizeos.export.retried",
        targetType: "suggested_agent_run",
        targetId: id,
        metadata: result,
      })

      return NextResponse.json(result)
    } catch (error) {
      if (error instanceof RealizeOSPrivateMeetingError) return jsonError(error.code, error.status)

      return jsonError(
        error instanceof Error ? error.message : "Unable to retry RealizeOS export",
        error instanceof RealizeOSExportNotFoundError ? 404 : 400
      )
    }
  }
)
