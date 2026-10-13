import type { WorkspaceRole } from "@/lib/workspaces/types"

/** The workspace every pre-M2 row is migrated into (018/019). */
export const DEFAULT_WORKSPACE_ID = "ws_default"

/** httpOnly cookie holding the active workspace id for session users. */
export const ACTIVE_WORKSPACE_COOKIE = "meetsum_workspace"

/** Roles from least to most privileged. */
export const WORKSPACE_ROLES = [
  "viewer",
  "member",
  "admin",
  "owner",
] as const satisfies readonly WorkspaceRole[]

/** Numeric rank of a role: viewer 0 < member 1 < admin 2 < owner 3. */
export function roleRank(role: WorkspaceRole): number {
  return WORKSPACE_ROLES.indexOf(role)
}
