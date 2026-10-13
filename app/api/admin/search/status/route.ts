import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { getSearchCapabilities } from "@/lib/search/capabilities"
import { loadWorkspaceIndexStatus } from "@/lib/search/index-sweep"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/admin/search/status (docs/parity/m6.md A7; owner: Package A):
 * the workspace's meeting counts by index state and mode, the search
 * capabilities (pgvector, HNSW index, Hebrew trigrams, with the reason when
 * search runs lexical), the active embedding key and its coverage.
 */
export const GET = withAuthz("ops:read", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.admin)

  if (rateLimit.blocked) return rateLimit.blocked

  try {
    const capabilities = await getSearchCapabilities({ refresh: new URL(request.url).searchParams.has("refresh") })
    const status = await loadWorkspaceIndexStatus(ctx.workspace.id, capabilities.embeddingKey)

    return NextResponse.json(
      {
        storage: process.env.MEETSUM_STORAGE === "postgres" ? "postgres" : "memory",
        mode: capabilities.vector.indexReady && capabilities.embeddingKey ? "hybrid" : "lexical",
        ...status,
        capabilities,
      },
      { headers: rateLimit.headers }
    )
  } catch {
    return jsonError("Failed to load search status", 500)
  }
})
