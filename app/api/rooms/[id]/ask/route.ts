import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { askResultStatus, legacyMemoryAnswer, parseQuestion } from "@/lib/ask/http"
import { askOnce } from "@/lib/ask/service"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/rooms/:id/ask `{question}` — compat route over AskMeetSum in
 * room scope (docs/parity/m6.md, C8; permission `meeting:read`). Keeps the
 * legacy `{answer, citations: MemoryCitation[]}` shape (plus
 * `status`/`grounded`). A foreign room is a 404. Not persisted.
 */
export const POST = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.ask)

  if (rateLimit.blocked) return rateLimit.blocked

  const { id } = await params
  const input = (await request.json().catch(() => ({}))) as { question?: unknown }
  const question = parseQuestion(input.question)

  if (!question.ok) return jsonError(question.error, 400)

  const result = await askOnce(ctx, { question: question.value, scope: { kind: "room", roomId: id }, persist: false }, request.signal)

  if (result.error?.code === "not_found") return jsonError("Room not found", 404)
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: askResultStatus(result), headers: rateLimit.headers })

  return NextResponse.json(legacyMemoryAnswer(result), { headers: rateLimit.headers })
})
