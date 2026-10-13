import { NextResponse } from "next/server"

import {
  extractBearerToken,
  hasAuthorizationHeader,
  resolveEnvApiKey,
  verifyDatabaseApiKey,
  type ApiKeyPrincipal,
} from "@/lib/auth/api-keys"
import {
  SESSION_COOKIE,
  getSessionSecret,
  readRequestCookie,
  verifySessionCookie,
} from "@/lib/auth/session"
import type {
  MeetingRecord,
  MeetingRepository,
  RepoScope,
} from "@/lib/meetings/repository"
import { getScopedMeetingRepository } from "@/lib/meetings/store"
import { ACTIVE_WORKSPACE_COOKIE, roleRank } from "@/lib/workspaces/constants"
import {
  getWorkspaceStore,
  type MembershipWithWorkspace,
  type StoredUser,
  type WorkspaceStore,
} from "@/lib/workspaces/store"
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
  | "comments:write"

const VIEWER_PERMISSIONS = [
  "workspace:read",
  "meeting:read",
  "jobs:read",
  // M5: viewers can comment (comments additionally need a user principal).
  "comments:write",
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


/** Permissions of a role, as a fresh array (for `/api/me`). */
export function permissionsForRole(role: WorkspaceRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]]
}

function forbidden(permission: Permission) {
  return NextResponse.json({ error: "Forbidden", permission }, { status: 403 })
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function noWorkspace() {
  return NextResponse.json(
    { error: "no_workspace", message: "You are not a member of any workspace" },
    { status: 403 }
  )
}

function forbiddenOrigin() {
  return NextResponse.json(
    { error: "Forbidden", reason: "origin" },
    { status: 403 }
  )
}

function authUnavailable(error: unknown) {
  console.error("[auth] authentication failed", error)

  return NextResponse.json(
    { error: "Authentication unavailable" },
    { status: 503 }
  )
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function hostOf(value: string | null | undefined): string | undefined {
  if (!value) return undefined

  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * CSRF guard for cookie-authenticated requests: unsafe methods must carry an
 * Origin (or Referer) whose host is the request host or the configured
 * `NEXT_PUBLIC_APP_URL` host. Bearer-authenticated requests are not subject
 * to it (browsers never attach bearer tokens implicitly).
 */
export function isTrustedOrigin(
  request: Pick<Request, "method" | "headers" | "url">,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true

  const origin = request.headers.get("origin")
  const source =
    origin && origin !== "null"
      ? hostOf(origin)
      : origin === "null"
        ? undefined
        : hostOf(request.headers.get("referer"))

  if (!source) return false

  const allowed = new Set<string>()
  const add = (value: string | null | undefined) => {
    const trimmed = value?.split(",")[0]?.trim().toLowerCase()

    if (trimmed) allowed.add(trimmed)
  }

  add(request.headers.get("x-forwarded-host"))
  add(request.headers.get("host"))
  add(hostOf(request.url))
  add(hostOf(env.NEXT_PUBLIC_APP_URL))

  return allowed.has(source)
}

/**
 * Active workspace for a session user: the cookie's workspace if they are a
 * member, else their default workspace, else their oldest membership.
 */
export function selectActiveMembership<M extends Membership>(
  memberships: readonly M[],
  options: { cookieWorkspaceId?: string; defaultWorkspaceId?: string }
): M | undefined {
  const byId = (id: string | undefined) =>
    id ? memberships.find((membership) => membership.workspaceId === id) : undefined

  return (
    byId(options.cookieWorkspaceId) ??
    byId(options.defaultWorkspaceId) ??
    memberships[0]
  )
}

function publicUser(user: StoredUser): WorkspaceUser {
  return {
    id: user.id,
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    ...(user.picture ? { picture: user.picture } : {}),
  }
}

/** Signed-in, enabled user behind the request's session cookie, if any. */
async function resolveSessionUser(
  request: Pick<Request, "headers">,
  store: WorkspaceStore
): Promise<StoredUser | undefined> {
  let secret: string

  try {
    secret = getSessionSecret()
  } catch (error) {
    // Fail closed: a misconfigured secret never grants access.
    console.error("[auth] session secret unavailable", error)
    return undefined
  }

  const session = verifySessionCookie(readRequestCookie(request, SESSION_COOKIE), {
    secret,
  })

  if (!session) return undefined

  const user = await store.getUserById(session.userId)

  if (!user || user.disabledAt) return undefined
  if (user.email !== session.email.trim().toLowerCase()) return undefined

  return user
}

type Resolved<T> = { ok: true; value: T } | { ok: false; response: Response }

type SessionResolution = {
  user: StoredUser
  memberships: MembershipWithWorkspace[]
}

async function resolveSession(
  request: Pick<Request, "headers" | "method" | "url">,
  store: WorkspaceStore
): Promise<Resolved<SessionResolution>> {
  const user = await resolveSessionUser(request, store)

  if (!user) return { ok: false, response: unauthorized() }
  if (!isTrustedOrigin(request)) return { ok: false, response: forbiddenOrigin() }

  return {
    ok: true,
    value: { user, memberships: await store.listMembershipsForUser(user.id) },
  }
}

function buildContext(base: {
  principal: AuthPrincipal
  user?: WorkspaceUser
  apiKey?: AuthApiKey
  workspace: Workspace
  role: WorkspaceRole
}): AuthContext {
  return {
    ...base,
    meetings: getScopedMeetingRepository(toRepoScope(base)),
    audit: {
      workspaceId: base.workspace.id,
      actor: base.user?.email ?? (base.apiKey ? `api_key:${base.apiKey.id}` : undefined),
      ...(base.user ? { actorUserId: base.user.id } : {}),
      ...(base.apiKey ? { actorApiKeyId: base.apiKey.id } : {}),
    },
  }
}

async function contextForApiKey(
  key: ApiKeyPrincipal,
  store: WorkspaceStore
): Promise<AuthContext | undefined> {
  const scopeRole = scopesToRole(key.scopes)
  const workspace = await store.getWorkspace(key.workspaceId)

  if (!scopeRole || !workspace) return undefined

  // A database key acts for the member who minted it: it stops working when
  // that member is disabled or leaves the workspace, and never exceeds their
  // current role (demoting the creator demotes their keys).
  let role: WorkspaceRole = scopeRole

  if (key.createdByUserId) {
    const [creator, membership] = await Promise.all([
      store.getUserById(key.createdByUserId),
      store.getMembership(key.workspaceId, key.createdByUserId),
    ])

    if (!creator || creator.disabledAt || !membership) return undefined
    if (roleRank(membership.role) < roleRank(role)) role = membership.role
  }

  return buildContext({
    principal: "api_key",
    apiKey: {
      id: key.id,
      label: key.label,
      scopes: key.scopes,
      ...(key.createdByUserId ? { createdByUserId: key.createdByUserId } : {}),
    },
    workspace,
    role,
  })
}

/**
 * Authenticate a request and resolve its workspace context (M2 spec A2):
 * bearer → env key → DB key (an invalid bearer is a 401 with no cookie
 * fallback) → session → enabled user → active workspace (cookie if member,
 * else default, else oldest membership; none → 403 `no_workspace`).
 * Session requests with unsafe methods must pass the Origin check.
 */
export async function authenticateRequest(
  request: Request,
  store: WorkspaceStore = getWorkspaceStore()
): Promise<Resolved<AuthContext>> {
  try {
    if (hasAuthorizationHeader(request.headers)) {
      const token = extractBearerToken(request.headers)
      const key = token
        ? (resolveEnvApiKey(token) ?? (await verifyDatabaseApiKey(token)))
        : undefined
      const ctx = key ? await contextForApiKey(key, store) : undefined

      return ctx ? { ok: true, value: ctx } : { ok: false, response: unauthorized() }
    }

    const session = await resolveSession(request, store)

    if (!session.ok) return session

    const { user, memberships } = session.value
    const active = selectActiveMembership(memberships, {
      cookieWorkspaceId: readRequestCookie(request, ACTIVE_WORKSPACE_COOKIE),
      defaultWorkspaceId: user.defaultWorkspaceId,
    })

    if (!active) return { ok: false, response: noWorkspace() }

    return {
      ok: true,
      value: buildContext({
        principal: "user",
        user: publicUser(user),
        workspace: active.workspace,
        role: active.role,
      }),
    }
  } catch (error) {
    return { ok: false, response: authUnavailable(error) }
  }
}

/**
 * Authenticate, resolve workspace + role, and require `permission`.
 * Membership is re-checked on every request (removed members lose access
 * immediately even with a live cookie).
 */
export function withAuthz<P = Record<string, string>>(
  permission: Permission,
  handler: AuthzHandler<P>
): RouteHandler<P> {
  return async (request, route) => {
    const resolved = await authenticateRequest(request)

    if (!resolved.ok) return resolved.response
    if (!can(resolved.value.role, permission)) return forbidden(permission)

    return handler(request, resolved.value, route)
  }
}

/**
 * Require a signed-in user (no workspace needed): /api/me, workspace
 * creation/switching, invitation acceptance. API keys are rejected.
 */
export function withSession<P = Record<string, string>>(
  handler: SessionHandler<P>
): RouteHandler<P> {
  return async (request, route) => {
    if (hasAuthorizationHeader(request.headers)) return unauthorized()

    try {
      const session = await resolveSession(request, getWorkspaceStore())

      if (!session.ok) return session.response

      return handler(
        request,
        {
          user: publicUser(session.value.user),
          memberships: session.value.memberships,
        },
        route
      )
    } catch (error) {
      return authUnavailable(error)
    }
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
  if (!reason.trim()) {
    throw new Error("withPublicRoute requires a reason")
  }

  return async (request, route) => handler(request, route)
}

export type ServerAuthState =
  | { status: "unauthenticated" }
  | { status: "no_workspace"; session: SessionContext }
  | { status: "ok"; session: SessionContext; ctx: AuthContext }

/**
 * Auth state for server components (no Request object): reads the session
 * and active-workspace cookies via `next/headers`.
 */
export async function getServerAuthState(): Promise<ServerAuthState> {
  const { headers } = await import("next/headers")
  const incoming = await headers()
  const request = new Request("http://server-component.internal/", {
    method: "GET",
    headers: { cookie: incoming.get("cookie") ?? "" },
  })
  const store = getWorkspaceStore()
  const session = await resolveSession(request, store)

  if (!session.ok) return { status: "unauthenticated" }

  const { user, memberships } = session.value
  const sessionContext: SessionContext = { user: publicUser(user), memberships }
  const active = selectActiveMembership(memberships, {
    cookieWorkspaceId: readRequestCookie(request, ACTIVE_WORKSPACE_COOKIE),
    defaultWorkspaceId: user.defaultWorkspaceId,
  })

  if (!active) return { status: "no_workspace", session: sessionContext }

  return {
    status: "ok",
    session: sessionContext,
    ctx: buildContext({
      principal: "user",
      user: sessionContext.user,
      workspace: active.workspace,
      role: active.role,
    }),
  }
}

/** Server-component auth context, or undefined (signed out / no workspace). */
export async function getServerAuthContext(): Promise<AuthContext | undefined> {
  const state = await getServerAuthState()

  return state.status === "ok" ? state.ctx : undefined
}
