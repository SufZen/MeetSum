import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { listMediaAssets } from "@/lib/storage/media-assets"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const url = new URL(request.url)
  const limit = Number(url.searchParams.get("limit") ?? 50)
  const assets = await listMediaAssets({ limit })

  return NextResponse.json({ assets })
}
