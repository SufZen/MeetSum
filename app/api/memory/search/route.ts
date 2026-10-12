import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { buildMeetingMemoryResults } from "@/lib/memory"
import type { MemorySearchFilters } from "@/lib/memory"

export const GET = withAuthz("meeting:read", async (request, ctx) => {
  const searchParams = new URL(request.url).searchParams
  const query = searchParams.get("query")?.trim() ?? ""
  const limit = Math.max(
    1,
    Math.min(Math.trunc(Number(searchParams.get("limit") ?? 20)) || 20, 50)
  )

  const filters: MemorySearchFilters = {}
  if (searchParams.get("roomId")) filters.roomId = searchParams.get("roomId")!
  if (searchParams.get("tag")) filters.tag = searchParams.get("tag")!
  if (searchParams.get("participant")) {
    filters.participant = searchParams.get("participant")!
  }
  if (searchParams.get("language"))
    filters.language = searchParams.get("language")!

  const meetings = query
    ? await ctx.meetings.searchMeetings(query, { limit })
    : await ctx.meetings.listMeetings({ limit })

  return NextResponse.json({
    results: buildMeetingMemoryResults(meetings, query, { limit, filters }),
  })
})
