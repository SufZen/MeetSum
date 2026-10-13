/**
 * Request glue for the comment and reaction routes (M5 C3/C4). Server-only.
 * Comments need a signed-in user principal: API keys (whatever their scope)
 * get 403 `user_required`.
 */
import { NextResponse } from "next/server"

import { toRepoScope, type AuthContext } from "@/lib/auth/authz"
import { CommentError, type CommentStoreContext } from "@/lib/comments/store"

export type CommentAuthor = { name: string }

export function userRequired() {
  return NextResponse.json({ error: "Forbidden", reason: "user_required" }, { status: 403 })
}

export function commentErrorResponse(error: unknown): Response {
  if (error instanceof CommentError) {
    if (error.code === "user_required") return userRequired()
    return NextResponse.json({ error: error.code }, { status: error.status })
  }
  throw error
}

type MemberDirectory = {
  ids: ReadonlySet<string>
  authors: Record<string, CommentAuthor>
}

async function loadMembers(workspaceId: string): Promise<MemberDirectory> {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")
  const members = await getWorkspaceStore().listMembers(workspaceId)

  return {
    ids: new Set(members.map((member) => member.userId)),
    authors: Object.fromEntries(
      members.map((member) => [
        member.userId,
        { name: member.user.name?.trim() || member.user.email.split("@")[0] || member.userId },
      ])
    ),
  }
}

/**
 * Store context of a user principal, or undefined for API keys. Members are
 * loaded once per request (mention validation + author names).
 */
export function commentStoreContext(
  ctx: Pick<AuthContext, "principal" | "user" | "apiKey" | "workspace" | "role" | "meetings">
): (CommentStoreContext & { members: () => Promise<MemberDirectory> }) | undefined {
  if (ctx.principal !== "user" || !ctx.user) return undefined

  let cached: Promise<MemberDirectory> | undefined
  const members = () => (cached ??= loadMembers(ctx.workspace.id))

  return {
    scope: toRepoScope(ctx),
    userId: ctx.user.id,
    meetings: ctx.meetings,
    listMemberIds: async () => (await members()).ids,
    members,
  }
}
