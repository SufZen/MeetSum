import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { searchContextFrom } from "@/lib/search/context"
import { listSearchFacets } from "@/lib/search/facets"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/search/facets — filter values (people, speakers, rooms, tags,
 * languages, meeting types, sources) from the caller's visible meetings
 * (docs/parity/m6.md, B7).
 */
export const GET = withAuthz("meeting:read", async (_request, ctx) => {
  try {
    // Body is the frozen `SearchFacets` contract itself.
    return NextResponse.json(await listSearchFacets(searchContextFrom(ctx)))
  } catch (error) {
    console.error("[search] facets failed:", error instanceof Error ? error.name : "unknown")

    return NextResponse.json({ error: "Facets failed" }, { status: 500 })
  }
})
