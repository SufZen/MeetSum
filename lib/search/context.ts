/**
 * Search context from an auth context (docs/parity/m6.md, Step 0; owner:
 * Package B). Real: the repository scope drives `meetingScopeSql`, and the
 * principal key keys the per-principal query-embedding cache.
 */
import { toRepoScope, type AuthContext } from "@/lib/auth/authz"
import type { SearchContext } from "@/lib/search/types"

export function searchContextFrom(ctx: AuthContext): SearchContext {
  return {
    scope: toRepoScope(ctx),
    workspaceId: ctx.workspace.id,
    principalKey: ctx.user?.id ?? "key:" + ctx.apiKey?.id,
    meetings: ctx.meetings,
  }
}
