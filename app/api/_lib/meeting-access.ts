import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import type { AuthContext } from "@/lib/auth/authz"
import type { MeetingRecord } from "@/lib/meetings/repository"

/**
 * Shared helpers for the product meeting routes (M2 Package D).
 *
 * Every route reads meetings through `ctx.meetings`, which is already scoped
 * to what the principal may see. A meeting that is invisible or belongs to
 * another workspace is therefore indistinguishable from a missing one and is
 * always answered with 404 (no existence leak).
 */

export function meetingNotFound() {
  return jsonError("Meeting not found", 404)
}

/** 403 for share / visibility changes without owner-or-admin rights. */
export function meetingManageForbidden() {
  return NextResponse.json(
    { error: "Forbidden", reason: "meeting_manage_required" },
    { status: 403 }
  )
}

/** Loads a meeting the caller can see, or undefined (-> 404). */
export async function loadVisibleMeeting(
  ctx: Pick<AuthContext, "meetings">,
  meetingId: string
): Promise<MeetingRecord | undefined> {
  if (!meetingId) return undefined

  return ctx.meetings.getMeeting(meetingId)
}

/** Audit-log identity fields for the current principal. */
export function auditActor(ctx: Pick<AuthContext, "audit">) {
  return {
    workspaceId: ctx.audit.workspaceId,
    actor: ctx.audit.actor,
    actorUserId: ctx.audit.actorUserId,
    actorApiKeyId: ctx.audit.actorApiKeyId,
  }
}

/** User id that owns meetings created by this principal. */
export function creatorUserId(
  ctx: Pick<AuthContext, "principal" | "user" | "apiKey">
): string | undefined {
  return ctx.principal === "user" ? ctx.user?.id : ctx.apiKey?.createdByUserId
}
