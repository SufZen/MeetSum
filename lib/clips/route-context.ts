/**
 * Request glue for the clip routes (M5 C1/C2). Server-only.
 */
import { canManageMeeting, toRepoScope, type AuthContext } from "@/lib/auth/authz"
import type { ClipStoreContext } from "@/lib/clips/store"
import type { MeetingClip } from "@/lib/clips/types"
import type { MeetingRecord } from "@/lib/meetings/repository"

/** User id behind the principal (API keys act for their creator). */
export function actorUserId(ctx: Pick<AuthContext, "principal" | "user" | "apiKey">) {
  return ctx.principal === "user" ? ctx.user?.id : ctx.apiKey?.createdByUserId
}

export function clipStoreContext(
  ctx: Pick<AuthContext, "principal" | "user" | "apiKey" | "workspace" | "role" | "meetings">
): ClipStoreContext {
  return {
    scope: toRepoScope(ctx),
    actorUserId: actorUserId(ctx),
    meetings: ctx.meetings,
  }
}

/** Rename / delete: the clip's author, or whoever may manage the meeting. */
export function canManageClip(
  ctx: Pick<AuthContext, "principal" | "user" | "role">,
  clip: Pick<MeetingClip, "createdByUserId">,
  meeting: Pick<MeetingRecord, "ownerUserId">
): boolean {
  if (canManageMeeting(ctx, meeting)) return true

  return Boolean(
    ctx.principal === "user" && ctx.user && clip.createdByUserId && clip.createdByUserId === ctx.user.id
  )
}
