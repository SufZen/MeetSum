import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { isUsableTemplateKey } from "@/lib/ai/templates/catalog"
import { enqueueMeetSumJob, QueueUnavailableError } from "@/lib/jobs/queue"
import { createPlatformEvent } from "@/lib/platform/events"

const RUN_LANGUAGES = new Set(["he", "en"])

/**
 * POST /api/meetings/:id/intelligence/run `{templateKey?, language?}`:
 * enqueues `meeting.summarize`; both overrides pass through to the pipeline.
 */
export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params

    if (!(await loadVisibleMeeting(ctx, id))) return meetingNotFound()

    const body = (await request.json().catch(() => ({}))) as {
      templateKey?: unknown
      language?: unknown
    } | null
    const templateKey = body?.templateKey ?? undefined
    const language = body?.language ?? undefined

    if (templateKey !== undefined) {
      if (typeof templateKey !== "string" || !(await isUsableTemplateKey(ctx.workspace.id, templateKey))) {
        return NextResponse.json({ error: "unknown_template" }, { status: 400 })
      }
    }
    if (language !== undefined && (typeof language !== "string" || !RUN_LANGUAGES.has(language))) {
      return jsonError("language must be he or en", 400)
    }

    try {
      const job = await enqueueMeetSumJob("meeting.summarize", {
        meetingId: id,
        workspaceId: ctx.workspace.id,
        ...(templateKey === undefined ? {} : { templateKey }),
        ...(language === undefined ? {} : { language }),
      })

      return NextResponse.json(
        {
          job,
          event: createPlatformEvent("summary.created", { meetingId: id }),
        },
        { status: 202 }
      )
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        return NextResponse.json({ error: "queue_unavailable" }, { status: 503, headers: { "Retry-After": "10" } })
      }
      return jsonError(
        error instanceof Error ? error.message : "Unable to run intelligence",
        404
      )
    }
  }
)
