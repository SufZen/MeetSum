import type {
  AuthContext,
  AuthzHandler,
  Permission,
  RouteContext,
} from "@/lib/auth/authz"
import { createInMemoryMeetingRepository } from "@/lib/meetings/repository"
import type { WorkspaceRole } from "@/lib/workspaces/types"

/**
 * Builds an AuthContext for route tests. Package A owns real authentication;
 * route tests replace `withAuthz` with `mockWithAuthz` and decide the
 * principal/workspace/role per test through `testAuthState`.
 */
export function testAuthContext(
  options: {
    workspaceId?: string
    googleSubject?: string
    role?: WorkspaceRole
    principal?: AuthContext["principal"]
    email?: string
    meetings?: AuthContext["meetings"]
  } = {}
): AuthContext {
  const workspaceId = options.workspaceId ?? "ws_1"
  const principal = options.principal ?? "user"
  const email = options.email ?? "member@example.test"
  const user =
    principal === "user" ? { id: `user_${email}`, email } : undefined

  return {
    principal,
    user,
    apiKey:
      principal === "api_key"
        ? { id: "key_1", scopes: ["read", "write", "admin"] }
        : undefined,
    workspace: {
      id: workspaceId,
      name: workspaceId,
      slug: workspaceId,
      googleSubject: options.googleSubject,
    },
    role: options.role ?? "owner",
    meetings: options.meetings ?? createInMemoryMeetingRepository([]),
    audit: {
      workspaceId,
      actor: user?.email,
      actorUserId: user?.id,
      actorApiKeyId: principal === "api_key" ? "key_1" : undefined,
    },
  }
}

/** Mutable per-test state read by `mockWithAuthz`. */
export const testAuthState: {
  ctx: AuthContext | undefined
  permissions: Permission[]
} = { ctx: undefined, permissions: [] }

/**
 * Drop-in for `withAuthz`: no ctx → 401; otherwise checks the permission with
 * the real ROLE_PERMISSIONS table (`can`) and records which permission the
 * route asked for.
 */
export function createMockWithAuthz(
  can: (role: WorkspaceRole, permission: Permission) => boolean
) {
  return function mockWithAuthz<P>(
    permission: Permission,
    handler: AuthzHandler<P>
  ) {
    return async (request: Request, route: RouteContext<P>) => {
      testAuthState.permissions.push(permission)
      const ctx = testAuthState.ctx

      if (!ctx) {
        return Response.json({ error: "Unauthorized" }, { status: 401 })
      }

      if (!can(ctx.role, permission)) {
        return Response.json({ error: "Forbidden", permission }, { status: 403 })
      }

      return handler(request, ctx, route)
    }
  }
}

/** Module factory for `vi.mock("@/lib/auth/authz", ...)`. */
export async function mockAuthzModule(
  importOriginal: () => Promise<typeof import("@/lib/auth/authz")>
) {
  const actual = await importOriginal()

  return {
    ...actual,
    withAuthz: createMockWithAuthz(actual.can),
    withPublicRoute: <P>(
      _reason: string,
      handler: (request: Request, route: RouteContext<P>) => Response | Promise<Response>
    ) => async (request: Request, route: RouteContext<P>) => handler(request, route),
  }
}
