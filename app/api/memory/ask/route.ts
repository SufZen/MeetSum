import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { meetingRepository } from "@/lib/meetings/store"

export async function POST(request: Request) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const body = (await request.json().catch(() => ({}))) as { question?: unknown }
  const question = typeof body.question === "string" ? body.question.trim() : ""

  if (!question) return jsonError("Question is required", 400)

  const meetings = await meetingRepository.searchMeetings(question, { limit: 8 })
  const citations = meetings.flatMap((meeting) =>
    (meeting.transcript ?? [])
      .filter((segment) =>
        question
          .toLowerCase()
          .split(/\s+/)
          .filter((token) => token.length > 3)
          .some((token) => segment.text.toLowerCase().includes(token))
      )
      .slice(0, 2)
      .map((segment) => ({
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        segmentId: segment.id,
        startMs: segment.startMs,
      }))
  )

  return NextResponse.json({
    answer:
      meetings.length > 0
        ? meetings
            .slice(0, 3)
            .map((meeting) => `${meeting.title}: ${meeting.summary?.overview ?? "No summary yet."}`)
            .join("\n\n")
        : "No matching meeting memory was found yet.",
    citations,
  })
}
