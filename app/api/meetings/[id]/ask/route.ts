import { NextResponse } from "next/server"

import { meetingNotFound } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { askResultStatus, legacyMeetingAnswer, parseQuestion } from "@/lib/ask/http"
import { askOnce } from "@/lib/ask/service"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/meetings/:id/ask `{question}` — compat route over AskMeetSum in
 * meeting scope (docs/parity/m6.md, C8). Keeps the legacy
 * `{answer: {answer, citations: [{meetingId, segmentId, startMs}]}}` shape
 * (plus `status`/`grounded`). Not persisted as a thread.
 */
export const POST = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.ask)

  if (rateLimit.blocked) return rateLimit.blocked

  const { id } = await params
  const input = (await request.json().catch(() => ({}))) as { question?: unknown }
  const question = parseQuestion(input.question)

  if (!question.ok) return jsonError(question.error, 400)

  const result = await askOnce(ctx, { question: question.value, scope: { kind: "meeting", meetingId: id }, persist: false }, request.signal)

  if (result.error?.code === "not_found") return meetingNotFound()
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: askResultStatus(result), headers: rateLimit.headers })

  return NextResponse.json(legacyMeetingAnswer(result), { headers: rateLimit.headers })
})
