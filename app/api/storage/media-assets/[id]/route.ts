import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { deleteMediaAsset } from "@/lib/storage/media-assets"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params

  try {
    const asset = await deleteMediaAsset(id)

    return NextResponse.json({ asset })
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to delete media asset",
      404
    )
  }
}
