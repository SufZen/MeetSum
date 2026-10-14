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
import type { MeetingShare } from "@/lib/meetings/repository"
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { getAppSettings } from "@/lib/settings/app-settings"
import { validateSharePassword } from "@/lib/sharing/share-password"
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

/** The share as clients see it: never the password hash, only whether one is set. */
type MeetingShareDTO = Omit<MeetingShare, "passwordHash"> & { passwordProtected: boolean }

function shareDto(share: MeetingShare): MeetingShareDTO {
  const { passwordHash, ...rest } = share

  return { ...rest, passwordProtected: Boolean(passwordHash) }
}

/**
 * `password` of a PATCH body: absent → untouched, `null` → clear, a string →
 * set (8–128 characters), anything else → 400.
 */
function requestedPassword(body: Record<string, unknown>):
  | { change: false }
  | { change: true; password: string | null }
  | { error: Response } {
  if (!("password" in body) || body.password === undefined) return { change: false }
  if (body.password === null) return { change: true, password: null }

  const result = validateSharePassword(body.password)

  if ("error" in result) {
    return { error: NextResponse.json({ error: result.error }, { status: 400 }) }
  }

  return { change: true, password: result.password }
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
        share: shareDto(share),
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

/**
 * PATCH /api/meetings/:id/share — revoke/restore, regenerate, change the
 * sections, or set/clear the link password (`{ password: string | null }`,
 * M9 B4). `meeting:write`, a visible meeting, owner-or-admin, and the
 * `exports` rate limit. The password is hashed with scrypt and never echoed,
 * logged or audited; changing or clearing it invalidates access cookies.
 */
export const PATCH = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const rateLimit = await rateLimitRequest(request, RATE_LIMIT_PRESETS.exports)

    if (rateLimit.blocked) return rateLimit.blocked

    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()
    if (!canManageMeeting(ctx, meeting)) return meetingManageForbidden()

    const raw: unknown = await request.json().catch(() => ({}))
    const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
    const requested = requestedSections(body)

    if ("error" in requested) return requested.error

    const password = requestedPassword(body)

    if ("error" in password) return password.error

    try {
      const settings = await getAppSettings(ctx.workspace.id)

      if (!settings.publicSharingEnabled && body.revoked !== true) {
        return jsonError("Public sharing is disabled in Settings", 403)
      }

      let share = await ctx.meetings.updateMeetingShare(id, {
        revoked: typeof body.revoked === "boolean" ? body.revoked : undefined,
        regenerate: body.regenerate === true,
        includedSections: requested.sections,
      })

      if (password.change) {
        share = await ctx.meetings.updateMeetingSharePassword(share.id, password.password)
      }

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
          // Never the value or the hash: only what happened.
          ...(password.change ? { password: password.password === null ? "cleared" : "set" } : {}),
        },
      })

      return NextResponse.json(
        { share: shareDto(share), url: shareUrl(request, share.token) },
        { headers: rateLimit.headers }
      )
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Unable to update share link",
        400
      )
    }
  }
)
