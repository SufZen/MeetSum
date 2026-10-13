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
import { getAppSettings } from "@/lib/settings/app-settings"
import {
  InvalidShareSectionError,
  parseShareSections,
  type ShareSection,
} from "@/lib/sharing/share-sections"

/**
 * `includedSections` of a share request: undefined when absent, the parsed
 * list when valid, or an error response for an unknown section (M4: the
 * recording, `media`, is only shared when listed explicitly).
 */
function requestedSections(body: { includedSections?: unknown }):
  | { sections?: ShareSection[] }
  | { error: Response } {
  if (body.includedSections === undefined) return {}

  try {
    return { sections: parseShareSections(body.includedSections) }
  } catch (error) {
    if (error instanceof InvalidShareSectionError) {
      return { error: jsonError(`Unknown share section: ${error.section}`, 400) }
    }
    throw error
  }
}

function shareUrl(request: Request, token: string) {
  const url = new URL(request.url)

  return `${url.origin}/share/${token}`
}

/**
 * POST /api/meetings/:id/share — create (or return) the public share link.
 * Requires a visible meeting and owner-or-admin rights. Creating a link
 * switches the meeting to `link` visibility (M2).
 */
export const POST = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()
    if (!canManageMeeting(ctx, meeting)) return meetingManageForbidden()

    const body = await request.json().catch(() => ({}))
    const requested = requestedSections(body ?? {})

    if ("error" in requested) return requested.error

    try {
      const settings = await getAppSettings(ctx.workspace.id)

      if (!settings.publicSharingEnabled) {
        return jsonError("Public sharing is disabled in Settings", 403)
      }

      // Defaults never include the recording (`media` is opt-in).
      const defaultSections = [
        "summary",
        "decisions",
        settings.shareActionsByDefault ? "action_items" : undefined,
        settings.shareTranscriptByDefault ? "transcript" : undefined,
        "participants",
      ].filter((section): section is ShareSection => Boolean(section))

      const previousVisibility = meeting.visibility

      if (previousVisibility && previousVisibility !== "link") {
        await ctx.meetings.updateMeetingVisibility(id, "link")
      }

      const share = await ctx.meetings.createMeetingShare({
        meetingId: id,
        createdBy: ctx.audit.actor,
        includedSections: requested.sections ?? defaultSections,
      })
      await recordAuditLog({
        ...auditActor(ctx),
        action: "meeting.share.created",
        targetType: "meeting",
        targetId: id,
        metadata: {
          shareId: share.id,
          includedSections: share.includedSections,
          previousVisibility: previousVisibility ?? null,
        },
      })

      return NextResponse.json({
        share,
        url: shareUrl(request, share.token),
        visibility: "link",
      })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to create share link",
        400
      )
    }
  }
)

export const PATCH = withAuthz<{ id: string }>(
  "meeting:read",
  async (request, ctx, { params }) => {
    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()
    if (!canManageMeeting(ctx, meeting)) return meetingManageForbidden()

    const body = await request.json().catch(() => ({}))
    const requested = requestedSections(body ?? {})

    if ("error" in requested) return requested.error

    try {
      const settings = await getAppSettings(ctx.workspace.id)

      if (!settings.publicSharingEnabled && body.revoked !== true) {
        return jsonError("Public sharing is disabled in Settings", 403)
      }

      const share = await ctx.meetings.updateMeetingShare(id, {
        revoked: typeof body.revoked === "boolean" ? body.revoked : undefined,
        regenerate: body.regenerate === true,
        includedSections: requested.sections,
      })
      await recordAuditLog({
        ...auditActor(ctx),
        action: "meeting.share.updated",
        targetType: "meeting",
        targetId: id,
        metadata: {
          shareId: share.id,
          revoked: share.revoked,
          regenerate: body.regenerate === true,
          includedSections: share.includedSections,
        },
      })

      return NextResponse.json({ share, url: shareUrl(request, share.token) })
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to update share link",
        400
      )
    }
  }
)
