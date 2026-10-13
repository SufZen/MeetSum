import { NextResponse } from "next/server"

import { llmErrorResponse } from "@/app/api/_lib/llm-errors"
import {
  creatorUserId,
  loadVisibleMeeting,
  meetingNotFound,
  principalKey,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { can, toRepoScope, withAuthz } from "@/lib/auth/authz"
import { limitLlmOnDemand } from "@/lib/intelligence/on-demand"
import {
  buildMailto,
  FOLLOW_UP_TONES,
  FollowUpUnavailableError,
  generateFollowUpEmail,
  listFollowUpVariants,
  MAILTO_MAX_BODY_CHARS,
  MAX_FOLLOW_UP_RECIPIENTS,
  parseRecipients,
  type FollowUpTone,
} from "@/lib/intelligence/follow-up"

/** GET /api/meetings/:id/follow-up (M5 D5): generated variants. */
export const GET = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()

  const includeActionItems = new URL(request.url).searchParams.get("includeActionItems") !== "0"

  return NextResponse.json({
    variants: await listFollowUpVariants(toRepoScope(ctx), meeting, { includeActionItems }),
    mailtoMaxBodyChars: MAILTO_MAX_BODY_CHARS,
  })
})

/**
 * POST /api/meetings/:id/follow-up `{language, tone, includeActionItems?,
 * recipients?, force?}`: generates (or serves the cached) variant.
 *
 * The cached variant is shared by everyone who can see the meeting, so only
 * the language/tone enums select it and only meeting data feeds the model.
 * `recipients` (validated emails) only build the response's `mailto:`;
 * `includeActionItems` only shapes the response. Only `meeting:write` writes
 * or overwrites the shared row (`force` needs it too); viewers get a variant
 * that is returned but not saved (`ephemeral`).
 */
export const POST = withAuthz<{ id: string }>("meeting:read", async (request, ctx, { params }) => {
  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null
  const language = body?.language ?? "he"
  const tone = body?.tone ?? "formal"
  const includeActionItems = body?.includeActionItems ?? true
  const recipients = parseRecipients(body?.recipients)

  if (language !== "he" && language !== "en") return jsonError("language must be he or en", 400)
  if (!FOLLOW_UP_TONES.includes(tone as FollowUpTone)) {
    return jsonError("tone must be formal, friendly or concise", 400)
  }
  if (typeof includeActionItems !== "boolean") return jsonError("includeActionItems must be a boolean", 400)
  if (!recipients) {
    return jsonError(`recipients must be at most ${MAX_FOLLOW_UP_RECIPIENTS} email addresses`, 400)
  }
  if (body?.force !== undefined && typeof body.force !== "boolean") {
    return jsonError("force must be a boolean", 400)
  }
  const canWrite = can(ctx.role, "meeting:write")

  if (body?.force === true && !canWrite) {
    return NextResponse.json({ error: "Forbidden", permission: "meeting:write" }, { status: 403 })
  }

  const actorKey = principalKey(ctx)
  // Shared on-demand LLM budget (prep + follow-up), after authz and visibility.
  const limited = limitLlmOnDemand({ workspaceId: ctx.workspace.id, actorKey, canWrite })

  if (limited) return limited

  try {
    const variant = await generateFollowUpEmail(toRepoScope(ctx), meeting, {
      language,
      tone: tone as FollowUpTone,
      includeActionItems,
      force: body?.force === true,
      actorUserId: creatorUserId(ctx),
      actorKey,
      canWrite,
    })

    return NextResponse.json({
      variant,
      mailto: buildMailto(variant, recipients),
      mailtoMaxBodyChars: MAILTO_MAX_BODY_CHARS,
    })
  } catch (error) {
    if (error instanceof FollowUpUnavailableError) {
      return NextResponse.json({ error: "summary_required" }, { status: 409 })
    }

    return llmErrorResponse(error)
  }
})
