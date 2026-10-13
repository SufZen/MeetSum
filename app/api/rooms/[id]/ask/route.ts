import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { buildMeetingMemoryAnswer } from "@/lib/memory"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const POST = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.share)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as {
      question?: unknown
    }
    const question =
      typeof body.question === "string" ? body.question.trim() : ""

    if (!question) return jsonError("Question is required", 400)

    const rooms = await ctx.meetings.listRooms()
    const room = rooms.find((item) => item.id === id)

    if (!room) return jsonError("Room not found", 404)

    const meetings = await ctx.meetings.listMeetingsByContext(id)

    return NextResponse.json(buildMeetingMemoryAnswer(question, meetings), {
      headers: rateLimit.headers,
    })
  }
)
