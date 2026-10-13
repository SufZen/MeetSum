import { NextResponse } from "next/server"

import { llmErrorResponse } from "@/app/api/_lib/llm-errors"
import { loadVisibleMeeting, meetingNotFound } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { can, toRepoScope, withAuthz } from "@/lib/auth/authz"
import { generatePrepBrief, getPrepBrief } from "@/lib/intelligence/prep/brief"

function parseLanguage(value: unknown): string | undefined | false {
  if (value === undefined || value === null || value === "") return undefined

  return value === "he" || value === "en" ? value : false
}

/**
 * GET /api/meetings/:id/prep (M5 D4): the cached brief, or `{brief: null,
 * related}`. Related meetings come from what the caller can see.
 */
export const GET = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()

  const language = parseLanguage(new URL(request.url).searchParams.get("language"))

  if (language === false) return jsonError("language must be he or en", 400)

  return NextResponse.json(await getPrepBrief(toRepoScope(ctx), ctx.meetings, meeting, { language }))
})

/**
 * POST /api/meetings/:id/prep `{language?, force?}`: generates the brief
 * (works for upcoming calendar meetings). Viewers can generate (only from
 * meeting data they can see; `language` is an enum); `force` needs
 * meeting:write.
 */
export const POST = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()

  const body = (await request.json().catch(() => ({}))) as { language?: unknown; force?: unknown } | null
  const language = parseLanguage(body?.language)

  if (language === false) return jsonError("language must be he or en", 400)
  if (body?.force !== undefined && typeof body.force !== "boolean") {
    return jsonError("force must be a boolean", 400)
  }
  // The brief is one shared row per meeting and language: overwriting a
  // cached brief needs meeting:write.
  if (body?.force === true && !can(ctx.role, "meeting:write")) {
    return NextResponse.json({ error: "Forbidden", permission: "meeting:write" }, { status: 403 })
  }

  try {
    return NextResponse.json(
      await generatePrepBrief(toRepoScope(ctx), ctx.meetings, meeting, {
        language,
        force: body?.force === true,
        actorUserId: ctx.user?.id,
      })
    )
  } catch (error) {
    return llmErrorResponse(error)
  }
})
