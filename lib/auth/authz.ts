import { NextResponse } from "next/server"

import { requireAppAccess } from "@/lib/api/responses"
import { getCurrentSession } from "@/lib/auth/server"
import type {
  MeetingRecord,
  MeetingRepository,
  RepoScope,
} from "@/lib/meetings/repository"
import { getScopedMeetingRepository } from "@/lib/meetings/store"
import { DEFAULT_WORKSPACE_ID, roleRank } from "@/lib/workspaces/constants"
import type {
  Membership,
  Workspace,
  WorkspaceRole,
  WorkspaceUser,
} from "@/lib/workspaces/types"

/** API key scopes: admin > write > read (each includes the next). */
export type ApiKeyScope = "read" | "write" | "admin"

export type Permission =
  | "workspace:read"
  | "meeting:read"
  | "jobs:read"
  | "meeting:write"
  | "meeting:create"
  | "contexts:write"
  | "jobs:write"
  | "settings:write"
  | "members:manage"
  | "api_keys:manage"
  | "webhooks:manage"
  | "integrations:manage"
  | "storage:manage"
  | "audit:read"
  | "ops:read"
  | "owners:manage"
  | "workspace:delete"

const VIEWER_PERMISSIONS = [
  "workspace:read",
  "meeting:read",
  "jobs:read",
] as const satisfies readonly Permission[]

const MEMBER_PERMISSIONS = [
  ...VIEWER_PERMISSIONS,
  "meeting:write",
  "meeting:create",
  "contexts:write",
  "jobs:write",
] as const satisfies readonly Permission[]

const ADMIN_PERMISSIONS = [
  ...MEMBER_PERMISSIONS,
  "settings:write",
  "members:manage",
  "api_keys:manage",
  "webhooks:manage",
  "integrations:manage",
  "storage:manage",
  "audit:read",
  "ops:read",
] as const satisfies readonly Permission[]

const OWNER_PERMISSIONS = [
  ...ADMIN_PERMISSIONS,
  "owners:manage",
  "workspace:delete",
] as const satisfies readonly Permission[]

export const ROLE_PERMISSIONS: Readonly<
  Record<WorkspaceRole, readonly Permission[]>
> = {
  viewer: VIEWER_PERMISSIONS,
  member: MEMBER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  owner: OWNER_PERMISSIONS,
}

export function can(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission)
}

/**
 * Effective role of an API key: admin -> admin, write -> member,
 * read -> viewer (never owner). No recognised scope -> undefined (no access).
 */
export function scopesToRole(
  scopes: readonly unknown[] | null | undefined
): Exclude<WorkspaceRole, "owner"> | undefined {
  const values = new Set(scopes ?? [])

  if (values.has("admin")) return "admin"
  if (values.has("write")) return "member"
  if (values.has("read")) return "viewer"

  return undefined
}

export type AuthPrincipal = "user" | "api_key"

export type AuthApiKey = {
  id: string
  label?: string
  scopes: ApiKeyScope[]
  createdByUserId?: string
}

export type AuthAudit = {
  workspaceId: string
  actor?: string
  actorUserId?: string
  actorApiKeyId?: string
}

export type AuthContext = {
  principal: AuthPrincipal
  user?: WorkspaceUser
  apiKey?: AuthApiKey
  workspace: Workspace
  role: WorkspaceRole
  /** Meeting repository scoped to this principal. */
  meetings: MeetingRepository
  audit: AuthAudit
}

export type SessionContext = {
  user: WorkspaceUser
  memberships: Membership[]
}

/** Repository scope implied by an auth context. */
export function toRepoScope(
  ctx: Pick<AuthContext, "principal" | "user" | "apiKey" | "workspace" | "role">
): RepoScope {
  if (ctx.principal === "user" && ctx.user) {
    return {
      kind: "member",
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      email: ctx.user.email,
      role: ctx.role,
    }
  }

  return {
    kind: "api_key",
    workspaceId: ctx.workspace.id,
    ownerUserId: ctx.apiKey?.createdByUserId,
  }
}

/**
 * Share / visibility / delete rights on a meeting the caller can already
 * see: owner = me, or role >= admin. API keys need the `admin` scope
 * (which maps to role admin).
 */
export function canManageMeeting(
  ctx: Pick<AuthContext, "principal" | "user" | "role">,
  meeting: Pick<MeetingRecord, "ownerUserId">
): boolean {
  if (roleRank(ctx.role) >= roleRank("admin")) return true
  if (ctx.principal !== "user" || !ctx.user) return false

  return Boolean(meeting.ownerUserId && meeting.ownerUserId === ctx.user.id)
}

export type RouteContext<P> = { params: Promise<P> }

export type AuthzHandler<P> = (
  request: Request,
  ctx: AuthContext,
  route: RouteContext<P>
) => Response | Promise<Response>

export type SessionHandler<P> = (
  request: Request,
  session: SessionContext,
  route: RouteContext<P>
) => Response | Promise<Response>

export type RouteHandler<P> = (
  request: Request,
  route: RouteContext<P>
) => Promise<Response>

function forbidden(permission: Permission) {
  return NextResponse.json({ error: "Forbidden", permission }, { status: 403 })
}

/** COMPAT (M2 Step 0): the single legacy workspace. */
const COMPAT_WORKSPACE: Workspace = {
  id: DEFAULT_WORKSPACE_ID,
  name: "MeetSum",
  slug: "default",
}

async function readCompatSession() {
  try {
    return await getCurrentSession()
  } catch {
    // Fail closed: a broken session never grants access.
    return undefined
  }
}

function sessionUser(session: {
  email: string
  name?: string
  picture?: string
}): WorkspaceUser {
  // COMPAT: no users-table lookup yet; the email doubles as the user id.
  return {
    id: session.email,
    email: session.email,
    name: session.name,
    picture: session.picture,
  }
}

/**
 * Authenticate, resolve workspace + role, and require `permission`.
 *
 * COMPAT (M2 Step 0): authentication is the legacy `requireAppAccess`
 * (any valid credential = full access) and every principal is the owner of
 * `ws_default`. Package A replaces this body.
 */
export function withAuthz<P = Record<string, string>>(
  permission: Permission,
  handler: AuthzHandler<P>
): RouteHandler<P> {
  return async (request, route) => {
    const unauthorized = await requireAppAccess(request)

    if (unauthorized) return unauthorized

    const session = await readCompatSession()
    const role: WorkspaceRole = "owner"

    if (!can(role, permission)) return forbidden(permission)

    const user = session ? sessionUser(session) : undefined
    const apiKey: AuthApiKey | undefined = session
      ? undefined
      : { id: "legacy", scopes: ["read", "write", "admin"] }
    const base = {
      principal: (user ? "user" : "api_key") as AuthPrincipal,
      user,
      apiKey,
      workspace: COMPAT_WORKSPACE,
      role,
    }
    const ctx: AuthContext = {
      ...base,
      meetings: getScopedMeetingRepository(toRepoScope(base)),
      audit: {
        workspaceId: COMPAT_WORKSPACE.id,
        actor: user?.email,
        actorUserId: user?.id,
        actorApiKeyId: apiKey?.id,
      },
    }

    return handler(request, ctx, route)
  }
}

/**
 * Require a signed-in user (no workspace needed).
 * COMPAT (M2 Step 0): legacy session; owner of `ws_default`.
 */
export function withSession<P = Record<string, string>>(
  handler: SessionHandler<P>
): RouteHandler<P> {
  return async (request, route) => {
    const session = await readCompatSession()

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const user = sessionUser(session)

    return handler(
      request,
      {
        user,
        memberships: [
          { workspaceId: DEFAULT_WORKSPACE_ID, userId: user.id, role: "owner" },
        ],
      },
      route
    )
  }
}

/**
 * Explicitly public route. `reason` documents why it needs no credentials
 * (checked by the route-coverage test at Integration).
 */
export function withPublicRoute<P = Record<string, string>>(
  reason: string,
  handler: (
    request: Request,
    route: RouteContext<P>
  ) => Response | Promise<Response>
): RouteHandler<P> {
  void reason

  return async (request, route) => handler(request, route)
}
