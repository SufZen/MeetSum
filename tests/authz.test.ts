import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ROLE_PERMISSIONS,
  can,
  canManageMeeting,
  isTrustedOrigin,
  scopesToRole,
  selectActiveMembership,
  toRepoScope,
  withAuthz,
  withPublicRoute,
  withSession,
  type AuthContext,
  type Permission,
} from "@/lib/auth/authz"
import { ACTIVE_WORKSPACE_COOKIE, DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"
import {
  setWorkspaceStoreForTesting,
  type WorkspaceStore,
} from "@/lib/workspaces/store"
import type { WorkspaceRole } from "@/lib/workspaces/types"

import {
  TEST_SESSION_SECRET,
  addMember,
  freshStore,
  makeRequest,
  routeParams,
  seedWorkspace,
  sessionCookieFor,
} from "./helpers/workspace-auth"

const ALL_PERMISSIONS: Permission[] = [
  "workspace:read",
  "meeting:read",
  "jobs:read",
  "meeting:write",
  "meeting:create",
  "contexts:write",
  "jobs:write",
  "settings:write",
  "members:manage",
  "api_keys:manage",
  "webhooks:manage",
  "integrations:manage",
  "storage:manage",
  "audit:read",
  "ops:read",
  "owners:manage",
  "workspace:delete",
  "comments:write",
]

const EXPECTED: Record<WorkspaceRole, Permission[]> = {
  viewer: ["workspace:read", "meeting:read", "jobs:read", "comments:write"],
  member: [
    "workspace:read",
    "meeting:read",
    "jobs:read",
    "comments:write",
    "meeting:write",
    "meeting:create",
    "contexts:write",
    "jobs:write",
  ],
  admin: ALL_PERMISSIONS.filter(
    (permission) => permission !== "owners:manage" && permission !== "workspace:delete"
  ),
  owner: ALL_PERMISSIONS,
}

describe("role permission matrix", () => {
  for (const role of ["viewer", "member", "admin", "owner"] as const) {
    it(`${role} holds exactly its permissions`, () => {
      for (const permission of ALL_PERMISSIONS) {
        expect(can(role, permission), `${role} ${permission}`).toBe(
          EXPECTED[role].includes(permission)
        )
      }
      expect([...ROLE_PERMISSIONS[role]].sort()).toEqual([...EXPECTED[role]].sort())
    })
  }
})

describe("scopesToRole", () => {
  it("maps admin/write/read to admin/member/viewer and never owner", () => {
    expect(scopesToRole(["read", "write", "admin"])).toBe("admin")
    expect(scopesToRole(["write"])).toBe("member")
    expect(scopesToRole(["read"])).toBe("viewer")
    expect(scopesToRole(["owner"])).toBeUndefined()
    expect(scopesToRole([])).toBeUndefined()
    expect(scopesToRole(null)).toBeUndefined()
  })
})

describe("canManageMeeting", () => {
  const user = { id: "usr_me", email: "me@example.com" }

  it("allows the meeting owner and admins, not other members", () => {
    expect(canManageMeeting({ principal: "user", user, role: "member" }, { ownerUserId: "usr_me" })).toBe(true)
    expect(canManageMeeting({ principal: "user", user, role: "member" }, { ownerUserId: "usr_x" })).toBe(false)
    expect(canManageMeeting({ principal: "user", user, role: "viewer" }, { ownerUserId: undefined })).toBe(false)
    expect(canManageMeeting({ principal: "user", user, role: "admin" }, { ownerUserId: "usr_x" })).toBe(true)
  })

  it("requires the admin scope (role admin) for API keys", () => {
    expect(canManageMeeting({ principal: "api_key", role: "member" }, { ownerUserId: "usr_x" })).toBe(false)
    expect(canManageMeeting({ principal: "api_key", role: "admin" }, { ownerUserId: "usr_x" })).toBe(true)
  })
})

describe("selectActiveMembership", () => {
  const memberships = [
    { workspaceId: "ws_old", userId: "u", role: "member" as const },
    { workspaceId: "ws_new", userId: "u", role: "admin" as const },
  ]

  it("prefers the cookie, then the default, then the oldest membership", () => {
    expect(selectActiveMembership(memberships, { cookieWorkspaceId: "ws_new" })?.workspaceId).toBe("ws_new")
    expect(
      selectActiveMembership(memberships, { cookieWorkspaceId: "ws_gone", defaultWorkspaceId: "ws_new" })
        ?.workspaceId
    ).toBe("ws_new")
    expect(selectActiveMembership(memberships, { cookieWorkspaceId: "ws_gone" })?.workspaceId).toBe("ws_old")
    expect(selectActiveMembership([], {})).toBeUndefined()
  })
})

describe("isTrustedOrigin", () => {
  const env = { NEXT_PUBLIC_APP_URL: "https://meetsum.example.com" } as unknown as NodeJS.ProcessEnv
  const req = (method: string, headers: Record<string, string>) =>
    new Request("http://internal:3000/api/x", { method, headers })

  it("ignores safe methods", () => {
    expect(isTrustedOrigin(req("GET", {}), env)).toBe(true)
  })

  it("accepts the request host or the configured app host", () => {
    expect(isTrustedOrigin(req("POST", { origin: "http://internal:3000" }), env)).toBe(true)
    expect(isTrustedOrigin(req("POST", { origin: "https://meetsum.example.com" }), env)).toBe(true)
    expect(
      isTrustedOrigin(req("PATCH", { referer: "https://meetsum.example.com/en/settings" }), env)
    ).toBe(true)
  })

  it("rejects foreign, null and missing origins", () => {
    expect(isTrustedOrigin(req("POST", { origin: "https://evil.example" }), env)).toBe(false)
    expect(isTrustedOrigin(req("DELETE", { origin: "null" }), env)).toBe(false)
    expect(isTrustedOrigin(req("POST", {}), env)).toBe(false)
  })
})

describe("withAuthz", () => {
  let store: WorkspaceStore
  const seen: AuthContext[] = []
  const handler = (permission: Permission) =>
    withAuthz(permission, async (_request, ctx) => {
      seen.push(ctx)
      return Response.json({ workspaceId: ctx.workspace.id, role: ctx.role })
    })

  beforeEach(() => {
    store = freshStore()
    setWorkspaceStoreForTesting(store)
    seen.length = 0
    vi.stubEnv("MEETSUM_SESSION_SECRET", TEST_SESSION_SECRET)
    vi.stubEnv("MEETSUM_STORAGE", "memory")
    vi.stubEnv("MEETSUM_API_KEYS", "env-bootstrap-key")
    vi.stubEnv("MEETSUM_API_KEY_HASHES", "")
    vi.stubEnv("MEETSUM_ENV_API_KEY_SCOPES", "")
    vi.stubEnv("MEETSUM_ENV_API_KEY_WORKSPACE_ID", "")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
  })

  afterEach(() => {
    setWorkspaceStoreForTesting(undefined)
    vi.unstubAllEnvs()
  })

  it("401s without credentials", async () => {
    const response = await handler("meeting:read")(makeRequest("http://localhost/api/x"), routeParams({}))

    expect(response.status).toBe(401)
  })

  it("401s an invalid bearer even when a valid session cookie is present", async () => {
    const { owner } = await seedWorkspace(store, "W1", "owner@example.com")
    const response = await handler("meeting:read")(
      makeRequest("http://localhost/api/x", {
        bearer: "not-a-real-key",
        cookie: sessionCookieFor(owner),
      }),
      routeParams({})
    )

    expect(response.status).toBe(401)
    expect(seen).toHaveLength(0)
  })

  it("401s a non-bearer Authorization header instead of falling back to cookies", async () => {
    const { owner } = await seedWorkspace(store, "W1", "owner@example.com")
    const response = await handler("meeting:read")(
      makeRequest("http://localhost/api/x", {
        cookie: sessionCookieFor(owner),
        headers: { authorization: "Basic abc" },
      }),
      routeParams({})
    )

    expect(response.status).toBe(401)
  })

  it("binds env keys to ws_default with read,write (member) and refuses admin permissions", async () => {
    const read = await handler("meeting:create")(
      makeRequest("http://localhost/api/x", { bearer: "env-bootstrap-key" }),
      routeParams({})
    )

    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ workspaceId: DEFAULT_WORKSPACE_ID, role: "member" })
    expect(seen[0]).toMatchObject({
      principal: "api_key",
      apiKey: { id: "env" },
      audit: { workspaceId: DEFAULT_WORKSPACE_ID, actorApiKeyId: "env" },
    })
    expect(toRepoScope(seen[0])).toEqual({
      kind: "api_key",
      workspaceId: DEFAULT_WORKSPACE_ID,
      ownerUserId: undefined,
    })

    const admin = await handler("settings:write")(
      makeRequest("http://localhost/api/x", { method: "PATCH", bearer: "env-bootstrap-key" }),
      routeParams({})
    )

    expect(admin.status).toBe(403)
    expect(await admin.json()).toEqual({ error: "Forbidden", permission: "settings:write" })
  })

  it("does not apply the Origin check to bearer requests", async () => {
    const response = await handler("meeting:write")(
      makeRequest("http://localhost/api/x", {
        method: "POST",
        bearer: "env-bootstrap-key",
        origin: "https://evil.example",
      }),
      routeParams({})
    )

    expect(response.status).toBe(200)
  })

  it("enforces the role matrix for session users", async () => {
    const { workspace } = await seedWorkspace(store, "W1", "owner@example.com")
    const viewer = await addMember(store, workspace.id, "viewer@example.com", "viewer")
    const member = await addMember(store, workspace.id, "member@example.com", "member")
    const admin = await addMember(store, workspace.id, "admin@example.com", "admin")
    const call = (user: { id: string; email: string }, permission: Permission) =>
      handler(permission)(
        makeRequest("http://localhost/api/x", { cookie: sessionCookieFor(user) }),
        routeParams({})
      ).then((response) => response.status)

    expect(await call(viewer, "meeting:read")).toBe(200)
    expect(await call(viewer, "meeting:write")).toBe(403)
    expect(await call(member, "meeting:write")).toBe(200)
    expect(await call(member, "members:manage")).toBe(403)
    expect(await call(admin, "members:manage")).toBe(200)
    expect(await call(admin, "owners:manage")).toBe(403)

    expect(seen.find((ctx) => ctx.user?.id === member.id)).toMatchObject({
      principal: "user",
      role: "member",
      workspace: { id: workspace.id },
      audit: { workspaceId: workspace.id, actorUserId: member.id, actor: "member@example.com" },
    })
  })

  it("re-checks membership per request: a removed member with a live cookie gets 403 no_workspace", async () => {
    const { workspace } = await seedWorkspace(store, "W1", "owner@example.com")
    const member = await addMember(store, workspace.id, "member@example.com", "member")
    const cookie = sessionCookieFor(member)
    const call = () =>
      handler("meeting:read")(makeRequest("http://localhost/api/x", { cookie }), routeParams({}))

    expect((await call()).status).toBe(200)
    await store.removeMember({ workspaceId: workspace.id, userId: member.id })

    const response = await call()

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: "no_workspace" })
  })

  it("ignores a stale active-workspace cookie for a workspace the user left", async () => {
    const w1 = await seedWorkspace(store, "W1", "one@example.com")
    const w2 = await seedWorkspace(store, "W2", "two@example.com")
    const user = await addMember(store, w1.workspace.id, "both@example.com", "viewer")

    await addMember(store, w2.workspace.id, "both@example.com", "member")
    await store.removeMember({ workspaceId: w2.workspace.id, userId: user.id })

    const response = await handler("meeting:read")(
      makeRequest("http://localhost/api/x", {
        cookie: `${sessionCookieFor(user)}; ${ACTIVE_WORKSPACE_COOKIE}=${w2.workspace.id}`,
      }),
      routeParams({})
    )

    expect(await response.json()).toEqual({ workspaceId: w1.workspace.id, role: "viewer" })
  })

  it("uses the active-workspace cookie when the user is a member there", async () => {
    const w1 = await seedWorkspace(store, "W1", "one@example.com")
    const w2 = await seedWorkspace(store, "W2", "two@example.com")
    const user = await addMember(store, w1.workspace.id, "both@example.com", "viewer")

    await addMember(store, w2.workspace.id, "both@example.com", "admin")

    const response = await handler("meeting:read")(
      makeRequest("http://localhost/api/x", {
        cookie: `${sessionCookieFor(user)}; ${ACTIVE_WORKSPACE_COOKIE}=${w2.workspace.id}`,
      }),
      routeParams({})
    )

    expect(await response.json()).toEqual({ workspaceId: w2.workspace.id, role: "admin" })
  })

  it("403s a cross-site unsafe session request (Origin check)", async () => {
    const { owner } = await seedWorkspace(store, "W1", "owner@example.com")
    const cookie = sessionCookieFor(owner)
    const evil = await handler("meeting:write")(
      makeRequest("http://localhost/api/x", { method: "POST", cookie, origin: "https://evil.example" }),
      routeParams({})
    )
    const missing = await handler("meeting:write")(
      makeRequest("http://localhost/api/x", { method: "DELETE", cookie, origin: null }),
      routeParams({})
    )
    const same = await handler("meeting:write")(
      makeRequest("http://localhost/api/x", { method: "POST", cookie }),
      routeParams({})
    )

    expect(evil.status).toBe(403)
    expect(await evil.json()).toMatchObject({ reason: "origin" })
    expect(missing.status).toBe(403)
    expect(same.status).toBe(200)
  })

  it("401s disabled or unknown users and v1 cookies", async () => {
    const response = await handler("meeting:read")(
      makeRequest("http://localhost/api/x", {
        cookie: sessionCookieFor({ id: "usr_ghost", email: "ghost@example.com" }),
      }),
      routeParams({})
    )

    expect(response.status).toBe(401)
  })

  it("fails closed when the session secret is missing", async () => {
    const { owner } = await seedWorkspace(store, "W1", "owner@example.com")
    const cookie = sessionCookieFor(owner)

    vi.stubEnv("MEETSUM_SESSION_SECRET", "")
    vi.spyOn(console, "error").mockImplementation(() => {})

    const response = await handler("meeting:read")(
      makeRequest("http://localhost/api/x", { cookie }),
      routeParams({})
    )

    expect(response.status).toBe(401)
  })
})

describe("withSession / withPublicRoute", () => {
  let store: WorkspaceStore

  beforeEach(() => {
    store = freshStore()
    setWorkspaceStoreForTesting(store)
    vi.stubEnv("MEETSUM_SESSION_SECRET", TEST_SESSION_SECRET)
    vi.stubEnv("MEETSUM_API_KEYS", "env-bootstrap-key")
  })

  afterEach(() => {
    setWorkspaceStoreForTesting(undefined)
    vi.unstubAllEnvs()
  })

  it("passes users without any membership and lists memberships otherwise", async () => {
    const lonely = await store.upsertUser({ email: "lonely@example.com" })
    const route = withSession(async (_request, session) =>
      Response.json({ id: session.user.id, count: session.memberships.length })
    )
    const response = await route(
      makeRequest("http://localhost/api/me", { cookie: sessionCookieFor(lonely) }),
      routeParams({})
    )

    expect(await response.json()).toEqual({ id: lonely.id, count: 0 })
  })

  it("rejects API keys and missing sessions", async () => {
    const route = withSession(async () => Response.json({ ok: true }))

    expect(
      (await route(makeRequest("http://localhost/api/me", { bearer: "env-bootstrap-key" }), routeParams({})))
        .status
    ).toBe(401)
    expect((await route(makeRequest("http://localhost/api/me"), routeParams({}))).status).toBe(401)
  })

  it("applies the Origin check to unsafe session requests", async () => {
    const user = await store.upsertUser({ email: "user@example.com" })
    const route = withSession(async () => Response.json({ ok: true }))
    const response = await route(
      makeRequest("http://localhost/api/workspaces", {
        method: "POST",
        cookie: sessionCookieFor(user),
        origin: "https://evil.example",
      }),
      routeParams({})
    )

    expect(response.status).toBe(403)
  })

  it("requires a reason for public routes and passes requests through", async () => {
    expect(() => withPublicRoute("  ", () => new Response())).toThrow(/reason/)

    const route = withPublicRoute("health", () => Response.json({ ok: true }))

    expect((await route(makeRequest("http://localhost/api/health"), routeParams({}))).status).toBe(200)
  })
})
