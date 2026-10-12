import { NextResponse } from "next/server"

import {
  auditActor,
  loadVisibleMeeting,
  meetingManageForbidden,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { jsonError } from "@/lib/api/responses"
import { recordAuditLog } from "@/lib/audit"
import { canManageMeeting, withAuthz } from "@/lib/auth/authz"
import type { MeetingVisibility } from "@/lib/meetings/repository"

const visibilities: readonly MeetingVisibility[] = [
  "private",
  "workspace",
  "link",
]

function parseVisibility(value: unknown): MeetingVisibility | undefined {
  return visibilities.includes(value as MeetingVisibility)
    ? (value as MeetingVisibility)
    : undefined
}

/**
 * PATCH /api/meetings/:id/visibility — `{ visibility: "private" | "workspace" | "link" }`.
 * Owner-or-admin only (API keys need the `admin` scope). Leaving `link`
 * revokes active share links in the same transaction (repository).
 */
export const PATCH = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as {
      visibility?: unknown
    }
    const visibility = parseVisibility(body.visibility)

    if (!visibility) {
      return jsonError(
        "visibility must be one of private, workspace, link",
        400
      )
    }

    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()
    if (!canManageMeeting(ctx, meeting)) return meetingManageForbidden()

    const previous = meeting.visibility ?? "workspace"

    try {
      const updated = await ctx.meetings.updateMeetingVisibility(id, visibility)

      await recordAuditLog({
        ...auditActor(ctx),
        action: "meeting.visibility.changed",
        targetType: "meeting",
        targetId: id,
        metadata: {
          from: previous,
          to: visibility,
          sharesRevoked: previous === "link" && visibility !== "link",
        },
      })

      return NextResponse.json({ meeting: updated })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to update visibility",
        400
      )
    }
  }
)
