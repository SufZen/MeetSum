import { NextResponse } from "next/server"

import { loadVisibleMeeting, meetingNotFound } from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { withAuthz } from "@/lib/auth/authz"
import { isUsableTemplateKey } from "@/lib/ai/templates/catalog"
import { requestMeetingReindex } from "@/lib/search/index-trigger"

/**
 * PATCH /api/meetings/:id/template `{templateKey: string | null}` (M5 D6):
 * per-meeting summary template; null falls back to the workspace default.
 */
export const PATCH = withAuthz<{ id: string }>("meeting:write", async (request, ctx, { params }) => {
  const { id } = await params
  const meeting = await loadVisibleMeeting(ctx, id)

  if (!meeting) return meetingNotFound()

  const body = (await request.json().catch(() => undefined)) as { templateKey?: unknown } | undefined
  const templateKey = body?.templateKey

  if (templateKey !== null && typeof templateKey !== "string") {
    return jsonError("templateKey must be a string or null", 400)
  }
  if (templateKey !== null && !(await isUsableTemplateKey(ctx.workspace.id, templateKey))) {
    return NextResponse.json({ error: "unknown_template" }, { status: 400 })
  }

  const updated = await ctx.meetings.setMeetingTemplate(id, templateKey)

  await recordAuditLog({
    action: "meeting.template.changed",
    ...ctx.audit,
    targetType: "meeting",
    targetId: id,
    metadata: { from: meeting.templateKey ?? null, to: templateKey },
  })

  await requestMeetingReindex({ workspaceId: ctx.workspace.id, meetingId: id, reason: "template" })

  return NextResponse.json({ meeting: { id: updated.id, templateKey: updated.templateKey ?? null } })
})
