import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { askResultStatus, legacyMemoryAnswer, parseQuestion } from "@/lib/ask/http"
import { askOnce } from "@/lib/ask/service"
import { withAuthz } from "@/lib/auth/authz"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/memory/ask `{question}` — compat route over AskMeetSum across
 * every visible meeting (docs/parity/m6.md, C8). Keeps the legacy
 * `{answer, citations: MemoryCitation[]}` shape (plus `status`/`grounded`).
 * Not persisted.
 */
export const POST = withAuthz("meeting:read", async (request, ctx) => {
  const rateLimit = rateLimitRequest(request, RATE_LIMIT_PRESETS.ask)

  if (rateLimit.blocked) return rateLimit.blocked

  const input = (await request.json().catch(() => ({}))) as { question?: unknown }
  const question = parseQuestion(input.question)

  if (!question.ok) return jsonError(question.error, 400)

  const result = await askOnce(ctx, { question: question.value, scope: { kind: "workspace" }, persist: false }, request.signal)

  if (result.error) return NextResponse.json({ error: result.error.message }, { status: askResultStatus(result), headers: rateLimit.headers })

  return NextResponse.json(legacyMemoryAnswer(result), { headers: rateLimit.headers })
})
