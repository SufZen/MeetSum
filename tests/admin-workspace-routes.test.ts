import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const audit = vi.hoisted(() => vi.fn(async () => {}))
const apiKeyMocks = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(async () => []),
  revokeApiKey: vi.fn(async () => null),
}))

vi.mock("@/lib/audit", () => ({ recordAuditLog: audit }))
vi.mock("@/lib/auth/api-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/api-keys")>()),
  ...apiKeyMocks,
}))

import { POST as createKey, GET as listKeys } from "@/app/api/admin/api-keys/route"
import { DELETE as revokeKey } from "@/app/api/admin/api-keys/[id]/route"
import { POST as acceptInvite } from "@/app/api/invitations/[token]/accept/route"
import { GET as previewInvite } from "@/app/api/invitations/[token]/route"
import { GET as me } from "@/app/api/me/route"
import { GET as getSettings, PATCH as patchSettings } from "@/app/api/settings/route"
import { POST as createWorkspace } from "@/app/api/workspaces/route"
import { PATCH as patchCurrent } from "@/app/api/workspaces/current/route"
import {
  GET as listInvitations,
  POST as invite,
} from "@/app/api/workspaces/current/invitations/route"
import { DELETE as revokeInvite } from "@/app/api/workspaces/current/invitations/[id]/route"
import { POST as resendInvite } from "@/app/api/workspaces/current/invitations/[id]/resend/route"
import { GET as listMembers } from "@/app/api/workspaces/current/members/route"
import {
  DELETE as removeMember,
  PATCH as patchMember,
} from "@/app/api/workspaces/current/members/[userId]/route"
import { POST as switchWorkspace } from "@/app/api/workspaces/switch/route"
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspaces/constants"
import { setWorkspaceStoreForTesting, type WorkspaceStore } from "@/lib/workspaces/store"
import type { Workspace, WorkspaceUser } from "@/lib/workspaces/types"

import {
  TEST_SESSION_SECRET,
  addMember,
  freshStore,
  makeRequest,
  routeParams,
  seedWorkspace,
  sessionCookieFor,
} from "./helpers/workspace-auth"

const BASE = "http://localhost"
const noParams = routeParams({})

let store: WorkspaceStore
let workspace: Workspace
let owner: WorkspaceUser
let admin: WorkspaceUser
let member: WorkspaceUser
let viewer: WorkspaceUser

const as = (user: WorkspaceUser, extraCookie = "") =>
  sessionCookieFor(user) + (extraCookie ? `; ${extraCookie}` : "")

beforeEach(async () => {
  store = freshStore()
  setWorkspaceStoreForTesting(store)
  vi.stubEnv("MEETSUM_SESSION_SECRET", TEST_SESSION_SECRET)
  vi.stubEnv("MEETSUM_RATE_LIMIT", "false")
  vi.stubEnv("MEETSUM_EMAIL_PROVIDER", "log")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://meetsum.example.com")
  vi.stubEnv("MEETSUM_ALLOW_WORKSPACE_CREATION", "")
  vi.spyOn(console, "info").mockImplementation(() => {})
  audit.mockClear()
  Object.values(apiKeyMocks).forEach((mock) => mock.mockClear())

  const seeded = await seedWorkspace(store, "Acme", "owner@example.com")

  workspace = seeded.workspace
  owner = seeded.owner
  admin = await addMember(store, workspace.id, "admin@example.com", "admin")
  member = await addMember(store, workspace.id, "member@example.com", "member")
  viewer = await addMember(store, workspace.id, "viewer@example.com", "viewer")
})

afterEach(() => {
  setWorkspaceStoreForTesting(undefined)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// makeRequest sends a same-origin Origin for unsafe methods; the app URL host
// differs, so these tests also exercise the request-host branch.

describe("/api/me and workspace switching", () => {
  it("returns the user, workspaces, active workspace and permissions", async () => {
    const response = await me(makeRequest(`${BASE}/api/me`, { cookie: as(viewer) }), noParams)
    const body = await response.json()

    expect(body).toMatchObject({
      user: { id: viewer.id, email: "viewer@example.com" },
      workspaces: [{ id: workspace.id, name: "Acme", role: "viewer" }],
      activeWorkspaceId: workspace.id,
      permissions: ["workspace:read", "meeting:read", "jobs:read", "comments:write"],
    })
  })

  it("works for a signed-in user without memberships", async () => {
    const lonely = await store.upsertUser({ email: "lonely@example.com" })
    const body = await (
      await me(makeRequest(`${BASE}/api/me`, { cookie: as(lonely) }), noParams)
    ).json()

    expect(body).toMatchObject({ workspaces: [], activeWorkspaceId: null, permissions: [] })
  })

  it("creates a workspace (creator = owner) and makes it active", async () => {
    vi.stubEnv("MEETSUM_ALLOW_WORKSPACE_CREATION", "true")

    const response = await createWorkspace(
      makeRequest(`${BASE}/api/workspaces`, { method: "POST", cookie: as(member), body: { name: "Side" } }),
      noParams
    )
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body).toMatchObject({ workspace: { name: "Side" }, role: "owner" })
    expect(response.headers.get("set-cookie")).toContain(`${ACTIVE_WORKSPACE_COOKIE}=${body.workspace.id}`)
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workspace.created", workspaceId: body.workspace.id }))
  })

  it.each(["", "1", "yes"])(
    "refuses workspace creation by default (MEETSUM_ALLOW_WORKSPACE_CREATION=%j)",
    async (value) => {
      vi.stubEnv("MEETSUM_ALLOW_WORKSPACE_CREATION", value)

      const response = await createWorkspace(
        makeRequest(`${BASE}/api/workspaces`, { method: "POST", cookie: as(member), body: { name: "Side" } }),
        noParams
      )

      expect(response.status).toBe(403)
    }
  )

  it("refuses workspace creation when MEETSUM_ALLOW_WORKSPACE_CREATION=false", async () => {
    vi.stubEnv("MEETSUM_ALLOW_WORKSPACE_CREATION", "false")

    const response = await createWorkspace(
      makeRequest(`${BASE}/api/workspaces`, { method: "POST", cookie: as(member), body: { name: "Side" } }),
      noParams
    )

    expect(response.status).toBe(403)
  })

  it("switches only into workspaces the user belongs to", async () => {
    const other = await seedWorkspace(store, "Other", "other@example.com")
    const denied = await switchWorkspace(
      makeRequest(`${BASE}/api/workspaces/switch`, {
        method: "POST",
        cookie: as(member),
        body: { workspaceId: other.workspace.id },
      }),
      noParams
    )

    expect(denied.status).toBe(404)

    await addMember(store, other.workspace.id, "member@example.com", "viewer")

    const allowed = await switchWorkspace(
      makeRequest(`${BASE}/api/workspaces/switch`, {
        method: "POST",
        cookie: as(member),
        body: { workspaceId: other.workspace.id },
      }),
      noParams
    )

    expect(allowed.status).toBe(200)
    expect(allowed.headers.get("set-cookie")).toContain(`${ACTIVE_WORKSPACE_COOKIE}=${other.workspace.id}`)
  })
})

describe("workspaces/current", () => {
  it("lets only an owner set google_subject, and only to their own email", async () => {
    const patch = (user: WorkspaceUser, googleSubject: string) =>
      patchCurrent(
        makeRequest(`${BASE}/api/workspaces/current`, { method: "PATCH", cookie: as(user), body: { googleSubject } }),
        noParams
      )

    expect((await patch(admin, "admin@example.com")).status).toBe(403)
    expect((await patch(owner, "someone@example.com")).status).toBe(403)

    const ok = await patch(owner, "Owner@Example.com")

    expect(ok.status).toBe(200)
    expect((await ok.json()).workspace.googleSubject).toBe("owner@example.com")
  })

  it("lets admins rename but not viewers", async () => {
    const rename = (user: WorkspaceUser) =>
      patchCurrent(
        makeRequest(`${BASE}/api/workspaces/current`, { method: "PATCH", cookie: as(user), body: { name: "Acme 2" } }),
        noParams
      )

    expect((await rename(viewer)).status).toBe(403)
    expect((await rename(admin)).status).toBe(200)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workspace.updated", workspaceId: workspace.id }))
  })
})

describe("members", () => {
  const patch = (actor: WorkspaceUser, target: WorkspaceUser, role: string) =>
    patchMember(
      makeRequest(`${BASE}/api/workspaces/current/members/${target.id}`, {
        method: "PATCH",
        cookie: as(actor),
        body: { role },
      }),
      routeParams({ userId: target.id })
    )
  const remove = (actor: WorkspaceUser, target: WorkspaceUser) =>
    removeMember(
      makeRequest(`${BASE}/api/workspaces/current/members/${target.id}`, { method: "DELETE", cookie: as(actor) }),
      routeParams({ userId: target.id })
    )

  it("lists members for any role", async () => {
    const response = await listMembers(makeRequest(`${BASE}/api/x`, { cookie: as(viewer) }), noParams)

    expect((await response.json()).members).toHaveLength(4)
  })

  it("lets admins change non-owner roles, not owner ones", async () => {
    expect((await patch(member, viewer, "member")).status).toBe(403)
    expect((await patch(admin, viewer, "member")).status).toBe(200)
    expect((await patch(admin, owner, "admin")).status).toBe(403)
    expect((await patch(admin, member, "owner")).status).toBe(403)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.role_changed", targetId: viewer.id, metadata: { from: "viewer", to: "member" } })
    )
  })

  it("protects the last owner from demotion, removal and leaving", async () => {
    const demote = await patch(owner, owner, "admin")

    expect(demote.status).toBe(409)
    expect(await demote.json()).toMatchObject({ error: "last_owner" })
    expect((await remove(owner, owner)).status).toBe(409)

    expect((await patch(owner, admin, "owner")).status).toBe(200)
    expect((await remove(owner, owner)).status).toBe(200)
  })

  it("lets anyone leave and only managers remove others", async () => {
    expect((await remove(member, viewer)).status).toBe(403)
    expect((await remove(viewer, viewer)).status).toBe(200)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "member.left", targetId: viewer.id }))
    expect((await remove(admin, member)).status).toBe(200)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "member.removed", targetId: member.id }))
    expect((await remove(admin, owner)).status).toBe(403)
  })

  it("404s users who are not members", async () => {
    const stranger = await store.upsertUser({ email: "stranger@example.com" })

    expect((await patch(admin, stranger as WorkspaceUser, "viewer")).status).toBe(404)
  })
})

describe("invitations", () => {
  const sendInvite = (actor: WorkspaceUser, body: unknown) =>
    invite(makeRequest(`${BASE}/api/workspaces/current/invitations`, { method: "POST", cookie: as(actor), body }), noParams)

  it("requires members:manage", async () => {
    expect((await sendInvite(member, { email: "new@example.com" })).status).toBe(403)
    expect(
      (await listInvitations(makeRequest(`${BASE}/api/x`, { cookie: as(viewer) }), noParams)).status
    ).toBe(403)
  })

  it("creates an invite, always returns inviteUrl, and records an email failure without failing", async () => {
    const response = await sendInvite(admin, { email: "New@Example.com", role: "viewer", locale: "he" })
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.inviteUrl).toMatch(/^https:\/\/meetsum\.example\.com\/he\/invite\/inv_[A-Za-z0-9_-]{43}$/)
    expect(body.emailSent).toBe(false)
    expect(body.invitation).toMatchObject({ email: "new@example.com", role: "viewer", status: "pending", lastSendError: "email_not_configured" })
    expect(JSON.stringify(body.invitation)).not.toMatch(/token/i)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "invitation.created", workspaceId: workspace.id }))
  })

  it("rejects existing members, owner role and bad emails", async () => {
    expect((await sendInvite(admin, { email: "member@example.com" })).status).toBe(409)
    expect((await sendInvite(admin, { email: "x@example.com", role: "owner" })).status).toBe(400)
    expect((await sendInvite(admin, { email: "not-an-email" })).status).toBe(400)
  })

  it("previews, revokes and resends (fresh token) invitations", async () => {
    const created = await (await sendInvite(admin, { email: "new@example.com" })).json()
    const token = created.inviteUrl.split("/").pop()
    const preview = await previewInvite(makeRequest(`${BASE}/api/invitations/${token}`), routeParams({ token }))

    expect(await preview.json()).toMatchObject({
      invitation: { email: "new@example.com", status: "pending" },
      workspace: { name: "Acme" },
    })
    expect(
      (await previewInvite(makeRequest(`${BASE}/api/invitations/bogus`), routeParams({ token: "bogus" }))).status
    ).toBe(404)

    const resent = await (
      await resendInvite(
        makeRequest(`${BASE}/api/x`, { method: "POST", cookie: as(admin) }),
        routeParams({ id: created.invitation.id })
      )
    ).json()

    expect(resent.inviteUrl).not.toBe(created.inviteUrl)
    expect(
      (await previewInvite(makeRequest(`${BASE}/api/x`), routeParams({ token }))).status
    ).toBe(404)

    const revoked = await revokeInvite(
      makeRequest(`${BASE}/api/x`, { method: "DELETE", cookie: as(admin) }),
      routeParams({ id: created.invitation.id })
    )

    expect(revoked.status).toBe(200)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "invitation.revoked" }))
  })

  it("accepts for the invited email only and activates the workspace", async () => {
    const created = await (await sendInvite(admin, { email: "new@example.com", role: "member" })).json()
    const token = created.inviteUrl.split("/").pop()
    const invitee = await store.upsertUser({ email: "new@example.com" })
    const accept = (user: WorkspaceUser) =>
      acceptInvite(
        makeRequest(`${BASE}/api/invitations/${token}/accept`, { method: "POST", cookie: as(user) }),
        routeParams({ token })
      )

    expect((await accept(viewer)).status).toBe(403)

    const response = await accept(invitee)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ workspace: { id: workspace.id }, role: "member" })
    expect(response.headers.get("set-cookie")).toContain(`${ACTIVE_WORKSPACE_COOKIE}=${workspace.id}`)
    expect((await accept(invitee)).status).toBe(200)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "invitation.accepted", actorUserId: invitee.id }))
  })
})

describe("settings and API keys", () => {
  it("reads settings with workspace:read and writes with settings:write", async () => {
    expect((await getSettings(makeRequest(`${BASE}/api/settings`, { cookie: as(viewer) }), noParams)).status).toBe(200)
    expect(
      (await patchSettings(makeRequest(`${BASE}/api/settings`, { method: "PATCH", cookie: as(member), body: { pwaRecorderEnabled: false } }), noParams)).status
    ).toBe(403)

    const ok = await patchSettings(
      makeRequest(`${BASE}/api/settings`, { method: "PATCH", cookie: as(admin), body: { pwaRecorderEnabled: false } }),
      noParams
    )

    expect(ok.status).toBe(200)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.settings.updated", workspaceId: workspace.id }))
    // M9: the workspace default locale never overwrites the user's locale cookie.
    expect(ok.headers.get("set-cookie") ?? "").not.toContain("meetsum_locale")
  })

  it("manages API keys only as admin, bound to the active workspace", async () => {
    apiKeyMocks.createApiKey.mockResolvedValue({
      rawKey: "ms_raw",
      record: { id: "api_key_1", keyPrefix: "ms_raw" },
    })

    expect((await listKeys(makeRequest(`${BASE}/api/x`, { cookie: as(member) }), noParams)).status).toBe(403)
    expect((await listKeys(makeRequest(`${BASE}/api/x`, { cookie: as(admin) }), noParams)).status).toBe(200)
    expect(apiKeyMocks.listApiKeys).toHaveBeenCalledWith(workspace.id)

    const created = await createKey(
      makeRequest(`${BASE}/api/x`, { method: "POST", cookie: as(admin), body: { label: "CI", scopes: ["admin"] } }),
      noParams
    )

    expect(created.status).toBe(201)
    expect(apiKeyMocks.createApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: workspace.id, scopes: ["read", "write", "admin"], createdByUserId: admin.id })
    )

    const badScopes = await createKey(
      makeRequest(`${BASE}/api/x`, { method: "POST", cookie: as(admin), body: { scopes: ["nope"] } }),
      noParams
    )

    expect(badScopes.status).toBe(400)

    const revoked = await revokeKey(
      makeRequest(`${BASE}/api/x`, { method: "DELETE", cookie: as(admin) }),
      routeParams({ id: "api_key_other" })
    )

    expect(revoked.status).toBe(404)
    expect(apiKeyMocks.revokeApiKey).toHaveBeenCalledWith(workspace.id, "api_key_other")
  })
})
