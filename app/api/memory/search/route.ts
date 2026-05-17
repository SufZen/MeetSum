import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { buildMeetingMemoryResults } from "@/lib/memory"
import { meetingRepository } from "@/lib/meetings/store"

export async function GET(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const searchParams = new URL(request.url).searchParams
  const query = searchParams.get("query")?.trim() ?? ""
  const limit = Math.max(
    1,
    Math.min(Math.trunc(Number(searchParams.get("limit") ?? 20)), 50)
  )

  const meetings = query
    ? await meetingRepository.searchMeetings(query, { limit })
    : await meetingRepository.listMeetings({ limit })

  return NextResponse.json({
    results: buildMeetingMemoryResults(meetings, query, { limit }),
  })
}
