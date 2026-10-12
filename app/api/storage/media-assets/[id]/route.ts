import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import {
  MediaAssetNotFoundError,
  deleteMediaAsset,
} from "@/lib/storage/media-assets"

export const DELETE = withAuthz<{ id: string }>(
  "storage:manage",
  async (_request, ctx, { params }) => {
    const { id } = await params

    try {
      const asset = await deleteMediaAsset(ctx.workspace.id, id)

      return NextResponse.json({ asset })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to delete media asset",
        error instanceof MediaAssetNotFoundError ? 404 : 400
      )
    }
  }
)
