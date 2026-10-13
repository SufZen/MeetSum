/**
 * Workspace analytics overview (docs/parity/m9.md C2). Runs the statements of
 * `sql.ts` (each built on the `visible` CTE) and folds them with
 * `compute.ts`. Demo (in-memory) storage has no SQL and answers an empty
 * overview rather than invented numbers. Server-only.
 */
import { computeAnalyticsOverview, emptyAnalyticsOverview, type AnalyticsRows } from "@/lib/analytics/dashboard/compute"
import { buildAnalyticsStatements } from "@/lib/analytics/dashboard/sql"
import type { AnalyticsOverview, AnalyticsQuery } from "@/lib/analytics/dashboard/types"
import type { Queryable } from "@/lib/db/client"
import type { RepoScope } from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

export type AnalyticsRequester = {
  workspaceId: string
  userId: string
  email: string
  role: WorkspaceRole
}

export function canSeeMemberBreakdown(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin"
}

async function defaultDb(): Promise<Queryable | undefined> {
  if (process.env.MEETSUM_STORAGE !== "postgres") return undefined

  const { getDatabasePool } = await import("@/lib/db/client")

  return getDatabasePool()
}

export async function getAnalyticsOverview(
  requester: AnalyticsRequester,
  query: AnalyticsQuery,
  deps: { db?: Queryable | null } = {}
): Promise<{ ok: true; overview: AnalyticsOverview } | { ok: false; error: "room_not_found" }> {
  const db = deps.db === undefined ? await defaultDb() : deps.db ?? undefined

  if (!db) return { ok: true, overview: emptyAnalyticsOverview(query) }

  if (query.roomId) {
    const room = await db.query(`select 1 from contexts where id = $1 and workspace_id = $2`, [
      query.roomId,
      requester.workspaceId,
    ])

    if (!room.rows.length) return { ok: false, error: "room_not_found" }
  }

  // The member scope for every role: admins get no private-meeting bypass.
  const scope: RepoScope = {
    kind: "member",
    workspaceId: requester.workspaceId,
    userId: requester.userId,
    email: requester.email,
    role: requester.role,
  }
  const statements = buildAnalyticsStatements(scope, query, { userId: requester.userId, email: requester.email })
  const results = await Promise.all(statements.map((statement) => db.query(statement.text, statement.values)))
  const rows = Object.fromEntries(statements.map((statement, index) => [statement.name, results[index]?.rows ?? []]))

  return {
    ok: true,
    overview: computeAnalyticsOverview(query, rows as unknown as AnalyticsRows, {
      userId: requester.userId,
      canSeeMembers: canSeeMemberBreakdown(requester.role),
    }),
  }
}
