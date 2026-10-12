import { getCurrentSession } from "@/lib/auth/server"
import type { MeetingRepository } from "@/lib/meetings/repository"
import { getScopedMeetingRepository } from "@/lib/meetings/store"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

export type ServerPageUser = {
  id: string
  email: string
  name?: string
  picture?: string
}

/**
 * Auth state of a server-rendered page (M2 D2):
 * - `anonymous`: no session -> redirect to login.
 * - `no_workspace`: signed in but not a member of any workspace -> show the
 *   no-access / pending-invitation state.
 * - `ok`: meetings repository scoped to the user's active workspace.
 */
export type ServerPageAuth =
  | { kind: "anonymous" }
  | { kind: "no_workspace"; user: ServerPageUser }
  | {
      kind: "ok"
      user: ServerPageUser
      workspaceId: string
      meetings: MeetingRepository
    }

/**
 * M2-integration: switch to getServerAuthContext.
 *
 * Package A adds `getServerAuthContext()` (session -> user -> active
 * workspace membership -> scoped `ctx.meetings`). Until it lands this local
 * fallback mirrors the Step 0 compat authz: any valid session is the owner
 * of `ws_default`. Keep every server page going through this single
 * function so the switch is a one-file change.
 */
export async function resolveServerPageAuth(): Promise<ServerPageAuth> {
  const session = await getCurrentSession().catch(() => undefined)

  if (!session) return { kind: "anonymous" }

  const user: ServerPageUser = {
    id: session.email,
    email: session.email,
    ...(session.name ? { name: session.name } : {}),
    ...(session.picture ? { picture: session.picture } : {}),
  }
  const workspaceId = DEFAULT_WORKSPACE_ID

  return {
    kind: "ok",
    user,
    workspaceId,
    meetings: getScopedMeetingRepository({
      kind: "member",
      workspaceId,
      userId: user.id,
      email: user.email,
      role: "owner",
    }),
  }
}
