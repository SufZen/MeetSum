import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { buildMeetingMemoryAnswer } from "@/lib/memory"
import { meetingRepository } from "@/lib/meetings/store"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export async function POST(request: Request) {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.share)

  if (rateLimit.blocked) return rateLimit.blocked

  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const body = (await request.json().catch(() => ({}))) as { question?: unknown }
  const question = typeof body.question === "string" ? body.question.trim() : ""

  if (!question) return jsonError("Question is required", 400)

  const meetings = await meetingRepository.searchMeetings(question, { limit: 12 })

  return NextResponse.json(buildMeetingMemoryAnswer(question, meetings), {
    headers: rateLimit.headers,
  })
}

