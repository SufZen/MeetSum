/**
 * M9 C1 `GET /api/me/invitations` and `POST /api/me/invitations/[id]/accept`
 * (docs/parity/m9.md): only invitations for the session email are listed;
 * accepting with another email is 403 and changes nothing; accepting joins
 * the workspace (the M2 transaction), is audited and idempotent; an expired
 * invitation is refused. Uses the in-memory workspace store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let session: { user: { id: string; email: string }; memberships: never[] } | undefined

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()

  return {
    ...actual,
    withSession:
      (handler: (request: Request, session: unknown, route: unknown) => Promise<Response>) =>
      async (request: Request, route: unknown) =>
        session ? handler(request, session, route) : Response.json({ error: "Unauthorized" }, { status: 401 }),
  }
})

const recordAuditLog = vi.hoisted(() => vi.fn(async (input: unknown) => input))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))
vi.mock("@/lib/users/preferences", () => ({
  getUserPreferences: async () => ({ locale: null, timeZone: null, notifications: { muted: [] } }),
}))

import { POST as accept } from "@/app/api/me/invitations/[id]/accept/route"
import { GET as listMine } from "@/app/api/me/invitations/route"
import { createCollabMemoryDb, setCollabBackendForTesting, type CollabMemoryDb } from "@/lib/clips/db"
import { enqueueNotification } from "@/lib/notifications/enqueue"
import { acceptInvitationById } from "@/lib/workspaces/invitations"
import { createInMemoryWorkspaceStore, setWorkspaceStoreForTesting, type WorkspaceStore } from "@/lib/workspaces/store"

let store: WorkspaceStore
let collab: CollabMemoryDb
let invitationId: string
let workspaceId: string
let invitee: { id: string; email: string }

beforeEach(async () => {
  store = createInMemoryWorkspaceStore({ seedDefaultWorkspace: false })
  setWorkspaceStoreForTesting(store)
  collab = createCollabMemoryDb()
  setCollabBackendForTesting({ kind: "memory", db: collab })

  const owner = await store.upsertUser({ email: "owner@acme.example", name: "Owner" })
  const user = await store.upsertUser({ email: "Invitee@Acme.example", name: "Invitee" })
  const workspace = await store.createWorkspace({ name: "Acme", createdByUserId: owner.id })
  const { invitation } = await store.createInvitation({
    workspaceId: workspace.id,
    email: "invitee@acme.example",
    role: "member",
    invitedByUserId: owner.id,
  })

  invitationId = invitation.id
  workspaceId = workspace.id
  invitee = { id: user.id, email: user.email }
  await enqueueNotification({
    workspaceId: workspace.id,
    userId: user.id,
    kind: "invited",
    payload: { invitationId: invitation.id, workspaceId: workspace.id, role: "member" },
  })
  recordAuditLog.mockClear()
})

afterEach(() => {
  session = undefined
  setWorkspaceStoreForTesting(undefined)
  setCollabBackendForTesting(undefined)
})

const route = (id: string) => ({ params: Promise.resolve({ id }) })

describe("GET /api/me/invitations", () => {
  it("lists pending invitations for the session email only", async () => {
    session = { user: invitee, memberships: [] }

    const mine = (await (await listMine(new Request("http://localhost/api/me/invitations"), { params: Promise.resolve({}) })).json()) as {
      invitations: Array<{ id: string; workspace: { name: string } }>
    }

    expect(mine.invitations.map((item) => [item.id, item.workspace.name])).toEqual([[invitationId, "Acme"]])

    session = { user: { id: invitee.id, email: "someone-else@acme.example" }, memberships: [] }

    const other = (await (await listMine(new Request("http://localhost/api/me/invitations"), { params: Promise.resolve({}) })).json()) as {
      invitations: unknown[]
    }

    expect(other.invitations).toEqual([])
  })
})

describe("POST /api/me/invitations/[id]/accept", () => {
  it("refuses another email with 403 and changes nothing", async () => {
    session = { user: { id: invitee.id, email: "mallory@acme.example" }, memberships: [] }

    const response = await accept(new Request("http://localhost/x", { method: "POST" }), route(invitationId))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: "email_mismatch" })
    expect(await store.getMembership(workspaceId, invitee.id)).toBeUndefined()
    expect(recordAuditLog).not.toHaveBeenCalled()
  })

  it("joins the workspace, audits and is idempotent", async () => {
    session = { user: invitee, memberships: [] }

    const first = await accept(new Request("http://localhost/x", { method: "POST" }), route(invitationId))

    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ role: "member", workspace: { id: workspaceId } })
    expect((await store.getMembership(workspaceId, invitee.id))?.role).toBe("member")
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "invitation.accepted", targetId: invitationId, workspaceId })
    )

    const again = await accept(new Request("http://localhost/x", { method: "POST" }), route(invitationId))

    expect(again.status).toBe(200)
  })

  it("answers 404 for an unknown or malformed id", async () => {
    session = { user: invitee, memberships: [] }

    expect((await accept(new Request("http://localhost/x", { method: "POST" }), route("inv_unknown"))).status).toBe(404)
    expect((await accept(new Request("http://localhost/x", { method: "POST" }), route("../../x"))).status).toBe(404)
  })

  it("refuses an expired invitation without extending it", async () => {
    await expect(
      acceptInvitationById(store, { workspaceId, invitationId, user: invitee }, Date.now() + 365 * 86_400_000)
    ).rejects.toMatchObject({ code: "invitation_invalid" })
    expect(await store.getMembership(workspaceId, invitee.id)).toBeUndefined()
  })
})
