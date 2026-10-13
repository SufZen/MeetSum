import type { AuthContext, Permission } from "@/lib/auth/authz"
import {
  createInMemoryMeetingRepository,
  type InMemoryMeetingDatabase,
  type MeetingRecord,
  type MeetingRepository,
} from "@/lib/meetings/repository"
import { canViewMeeting } from "@/lib/meetings/visibility"
import type { WorkspaceRole } from "@/lib/workspaces/types"

/**
 * Route-test harness for `withAuthz` handlers (M2 Package D).
 *
 * Usage in a test file:
 *
 *   vi.mock("@/lib/auth/authz", async (importOriginal) => {
 *     const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
 *     const { mockAuthzModule } = await import("./helpers/route-ctx")
 *     return mockAuthzModule(actual)
 *   })
 *
 * then `setRouteCtx(createTestCtx({...}))` before calling the handler. The
 * mocked `withAuthz` enforces the route permission with the real `can`.
 */

type AuthzModule = typeof import("@/lib/auth/authz")

let currentCtx: AuthContext | undefined

export function setRouteCtx(ctx: AuthContext | undefined) {
  currentCtx = ctx
}

export function mockAuthzModule(actual: AuthzModule): AuthzModule {
  const withAuthz: AuthzModule["withAuthz"] = (permission, handler) => {
    return async (request, route) => {
      const ctx = currentCtx

      if (!ctx) {
        return Response.json({ error: "Unauthorized" }, { status: 401 })
      }

      if (!actual.can(ctx.role, permission as Permission)) {
        return Response.json(
          { error: "Forbidden", permission },
          { status: 403 }
        )
      }

      return handler(request, ctx, route)
    }
  }

  return { ...actual, withAuthz }
}

/**
 * Wraps an in-memory repository so that reads apply the M2 visibility
 * rules for the given context (what Package B's scoped repository does).
 */
export function scopeRepository(
  base: MeetingRepository,
  ctx: Pick<
    AuthContext,
    "principal" | "user" | "apiKey" | "workspace" | "role"
  >,
  toScope: AuthzModule["toRepoScope"]
): MeetingRepository {
  const scope = toScope(ctx)
  const visible = (meeting: MeetingRecord | undefined) =>
    meeting &&
    canViewMeeting(
      scope,
      meeting,
      meeting.participantDetails?.map((participant) => participant.email) ?? []
    )
      ? meeting
      : undefined

  return {
    ...base,
    getMeeting: async (id) => visible(await base.getMeeting(id)),
    listMeetings: async (options) =>
      (await base.listMeetings(options)).filter((meeting) => visible(meeting)),
    searchMeetings: async (query, options) =>
      (await base.searchMeetings(query, options)).filter((meeting) =>
        visible(meeting)
      ),
  }
}

export function testMeeting(
  overrides: Partial<MeetingRecord> & { id: string }
): MeetingRecord {
  return {
    title: `Meeting ${overrides.id}`,
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-01T10:00:00.000Z",
    participants: [],
    workspaceId: "ws_a",
    ownerUserId: "user_owner",
    visibility: "workspace",
    ...overrides,
  }
}

export async function createTestCtx(options: {
  role?: WorkspaceRole
  principal?: "user" | "api_key"
  userId?: string
  email?: string
  workspaceId?: string
  apiKeyCreatedBy?: string
  meetings?: MeetingRecord[]
  repository?: MeetingRepository
  /** Shared in-memory database (e.g. seeded for several workspaces). */
  database?: InMemoryMeetingDatabase
}): Promise<AuthContext> {
  const { toRepoScope } = await import("@/lib/auth/authz")
  const role = options.role ?? "member"
  const principal = options.principal ?? "user"
  const workspaceId = options.workspaceId ?? "ws_a"
  const user =
    principal === "user"
      ? {
          id: options.userId ?? "user_me",
          email: options.email ?? "me@example.com",
        }
      : undefined
  const apiKey =
    principal === "api_key"
      ? {
          id: "key_1",
          scopes: ["read" as const],
          createdByUserId: options.apiKeyCreatedBy,
        }
      : undefined
  const base = {
    principal,
    user,
    apiKey,
    workspace: { id: workspaceId, name: "Workspace A", slug: "a" },
    role,
  }
  // The real in-memory repository enforces the M2 workspace/visibility scope
  // itself; a caller-supplied repository is wrapped to get the same rules.
  const meetings = options.repository
    ? scopeRepository(options.repository, base, toRepoScope)
    : createInMemoryMeetingRepository(
        options.database ?? options.meetings ?? [],
        toRepoScope(base)
      )

  return {
    ...base,
    meetings,
    audit: {
      workspaceId,
      actor: user?.email,
      actorUserId: user?.id,
      actorApiKeyId: apiKey?.id,
    },
  }
}

export function jsonRequest(
  url: string,
  method: string,
  body?: unknown
): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function routeParams<P>(params: P) {
  return { params: Promise.resolve(params) }
}
