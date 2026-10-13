import { NextResponse } from "next/server"

import { llmErrorResponse } from "@/app/api/_lib/llm-errors"
import { loadVisibleMeeting, meetingNotFound } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { toRepoScope, withAuthz } from "@/lib/auth/authz"
import {
  FOLLOW_UP_TONES,
  FollowUpUnavailableError,
  generateFollowUpEmail,
  listFollowUpVariants,
  MAILTO_MAX_BODY_CHARS,
  type FollowUpTone,
} from "@/lib/intelligence/follow-up"

const MAX_RECIPIENTS = 20

/** GET /api/meetings/:id/follow-up (M5 D5): generated variants. */
export const GET = withAuthz<{ id: string }>("meeting:read", async (_request, ctx, { params }) => {
  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()

  return NextResponse.json({
    variants: await listFollowUpVariants(toRepoScope(ctx), meeting),
    mailtoMaxBodyChars: MAILTO_MAX_BODY_CHARS,
  })
})

/**
 * POST /api/meetings/:id/follow-up `{language, tone, includeActionItems?,
 * recipients?, force?}`: generates (or serves the cached) variant.
 */
export const POST = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null
  const language = body?.language ?? "he"
  const tone = body?.tone ?? "formal"
  const includeActionItems = body?.includeActionItems ?? true
  const recipients = body?.recipients ?? []

  if (language !== "he" && language !== "en") return jsonError("language must be he or en", 400)
  if (!FOLLOW_UP_TONES.includes(tone as FollowUpTone)) {
    return jsonError("tone must be formal, friendly or concise", 400)
  }
  if (typeof includeActionItems !== "boolean") return jsonError("includeActionItems must be a boolean", 400)
  if (
    !Array.isArray(recipients) ||
    recipients.length > MAX_RECIPIENTS ||
    !recipients.every((recipient) => typeof recipient === "string" && recipient.length <= 200)
  ) {
    return jsonError(`recipients must be at most ${MAX_RECIPIENTS} strings`, 400)
  }
  if (body?.force !== undefined && typeof body.force !== "boolean") {
    return jsonError("force must be a boolean", 400)
  }

  try {
    const variant = await generateFollowUpEmail(toRepoScope(ctx), meeting, {
      language,
      tone: tone as FollowUpTone,
      includeActionItems,
      recipients: recipients as string[],
      force: body?.force === true,
      actorUserId: ctx.user?.id,
    })

    return NextResponse.json({ variant, mailtoMaxBodyChars: MAILTO_MAX_BODY_CHARS })
  } catch (error) {
    if (error instanceof FollowUpUnavailableError) {
      return NextResponse.json({ error: "summary_required" }, { status: 409 })
    }

    return llmErrorResponse(error)
  }
})
