import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { buildMeetingMemoryAnswer } from "@/lib/memory"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const POST = withAuthz("meeting:read", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.share)

  if (rateLimit.blocked) return rateLimit.blocked

  const body = (await request.json().catch(() => ({}))) as {
    question?: unknown
  }
  const question = typeof body.question === "string" ? body.question.trim() : ""

  if (!question) return jsonError("Question is required", 400)

  const meetings = await ctx.meetings.searchMeetings(question, { limit: 12 })

  return NextResponse.json(buildMeetingMemoryAnswer(question, meetings), {
    headers: rateLimit.headers,
  })
})
