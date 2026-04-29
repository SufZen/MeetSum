import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
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
    results: meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      startedAt: meeting.startedAt,
      status: meeting.status,
      tags: meeting.tags ?? [],
      overview: meeting.summary?.overview ?? "",
      actionItems: meeting.summary?.actionItems ?? [],
      transcriptMatches: (meeting.transcript ?? []).slice(0, 3),
    })),
  })
}
