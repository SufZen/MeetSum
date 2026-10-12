import { NextResponse } from "next/server"

import { toRepoScope, withAuthz } from "@/lib/auth/authz"
import { listMediaAssets } from "@/lib/storage/media-assets"

export const GET = withAuthz("storage:manage", async (request, ctx) => {
  const url = new URL(request.url)
  const limit = Number(url.searchParams.get("limit") ?? 50)
  const assets = await listMediaAssets(toRepoScope(ctx), { limit })

  return NextResponse.json({ assets })
})
