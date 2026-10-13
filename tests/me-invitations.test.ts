/**
 * M9 C1 `GET /api/me/invitations` and `POST /api/me/invitations/[id]/accept`
 * (docs/parity/m9.md; security review of invitation disclosure):
 * - user B can neither list nor accept A's invitation (404, same as unknown);
 * - an email-case variant works only for the true owner;
 * - expired, revoked and already-used invitations are rejected (404);
 * - listings expose only id, workspace name and inviter name; no token,
 *   email, workspace id or other invitees appear in any response;
 * - accept is audited and single-use.
 * Runs on the in-memory workspace store and on Postgres (PGlite).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

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
import { createCollabMemoryDb, setCollabBackendForTesting, type CollabBackend } from "@/lib/clips/db"
import { enqueueNotification } from "@/lib/notifications/enqueue"
import { acceptInvitationById } from "@/lib/workspaces/invitations"
import {
  createInMemoryWorkspaceStore,
  createPostgresWorkspaceStore,
  setWorkspaceStoreForTesting,
  type WorkspaceStore,
} from "@/lib/workspaces/store"

import { createM9Database, type PgLike } from "./helpers/pglite-m9"

type User = { id: string; email: string }
type Fixture = {
  store: WorkspaceStore
  workspaceId: string
  invitationId: string
  token: string
  alice: User
  bob: User
}

let pg: PgLike | undefined

beforeAll(async () => {
  pg = await createM9Database()
}, 120_000)

afterAll(async () => {
  await pg?.close()
})

afterEach(() => {
  session = undefined
  setWorkspaceStoreForTesting(undefined)
  setCollabBackendForTesting(undefined)
})

async function setup(store: WorkspaceStore, backend: CollabBackend, suffix: string): Promise<Fixture> {
  setWorkspaceStoreForTesting(store)
  setCollabBackendForTesting(backend)

  const owner = await store.upsertUser({ email: `owner-${suffix}@acme.example`, name: "Owner Name" })
  const alice = await store.upsertUser({ email: `alice-${suffix}@acme.example`, name: "Alice" })
  const bob = await store.upsertUser({ email: `bob-${suffix}@acme.example`, name: "Bob" })
  const workspace = await store.createWorkspace({ name: `Acme ${suffix}`, createdByUserId: owner.id })
  const { invitation, token } = await store.createInvitation({
    workspaceId: workspace.id,
    email: `Alice-${suffix}@ACME.example`,
    role: "member",
    invitedByUserId: owner.id,
  })

  // Only the invitee's account gets the notification.
  await enqueueNotification(
    {
      workspaceId: workspace.id,
      userId: alice.id,
      kind: "invited",
      payload: { invitationId: invitation.id, workspaceId: workspace.id, role: "member" },
    },
    backend
  )
  recordAuditLog.mockClear()

  return {
    store,
    workspaceId: workspace.id,
    invitationId: invitation.id,
    token,
    alice: { id: alice.id, email: alice.email },
    bob: { id: bob.id, email: bob.email },
  }
}

const listRequest = () => listMine(new Request("http://localhost/api/me/invitations"), { params: Promise.resolve({}) })
const acceptRequest = (id: string) =>
  accept(new Request("http://localhost/api/me/invitations/x/accept", { method: "POST" }), { params: Promise.resolve({ id }) })

const variants: Array<[string, () => Promise<Fixture | undefined>]> = [
  [
    "memory",
    async () =>
      setup(createInMemoryWorkspaceStore({ seedDefaultWorkspace: false }), { kind: "memory", db: createCollabMemoryDb() }, "mem"),
  ],
  [
    "postgres",
    async () => {
      if (!pg) return undefined
      await pg.exec("delete from notifications; delete from invitations; delete from memberships; delete from workspaces; delete from users;")
      return setup(createPostgresWorkspaceStore(pg), { kind: "postgres", client: pg }, "pg")
    },
  ],
]

for (const [name, make] of variants) {
  describe(`me/invitations (${name})`, () => {
    let fx: Fixture

    beforeEach(async (context) => {
      const built = await make()

      if (!built) {
        context.skip("PGlite did not load")
        return
      }
      fx = built
    })

    it("lists only the owner's pending invitation, with no token, email or ids beyond the invitation id", async () => {
      session = { user: fx.alice, memberships: [] }

      const response = await listRequest()
      const text = await response.text()

      expect(JSON.parse(text)).toEqual({
        invitations: [{ id: fx.invitationId, workspaceName: `Acme ${name === "memory" ? "mem" : "pg"}`, inviterName: "Owner Name" }],
      })
      expect(text).not.toContain(fx.token)
      expect(text.toLowerCase()).not.toContain("alice-")
      expect(text).not.toContain(fx.workspaceId)
    })

    it("hides it from user B, who cannot accept it either (404 like an unknown id)", async () => {
      session = { user: fx.bob, memberships: [] }

      expect(await (await listRequest()).json()).toEqual({ invitations: [] })

      const theirs = await acceptRequest(fx.invitationId)
      const unknown = await acceptRequest("inv_doesnotexist")

      expect(theirs.status).toBe(404)
      expect(unknown.status).toBe(404)
      expect(await theirs.json()).toEqual(await unknown.json())
      expect(await fx.store.getMembership(fx.workspaceId, fx.bob.id)).toBeUndefined()
      expect(recordAuditLog).not.toHaveBeenCalled()
    })

    it("never trusts a mismatched session email on the owner's user id", async () => {
      session = { user: { id: fx.alice.id, email: "mallory@acme.example" }, memberships: [] }

      expect((await acceptRequest(fx.invitationId)).status).toBe(404)
      expect(await fx.store.getMembership(fx.workspaceId, fx.alice.id)).toBeUndefined()
    })

    it("accepts for the owner with any email case, audits, and is single-use", async () => {
      session = { user: { id: fx.alice.id, email: fx.alice.email.toUpperCase() }, memberships: [] }

      const first = await acceptRequest(fx.invitationId)
      const text = await first.text()

      expect(first.status).toBe(200)
      expect(text).not.toContain(fx.token)
      expect(JSON.parse(text)).toMatchObject({ role: "member", workspace: { id: fx.workspaceId } })
      expect((await fx.store.getMembership(fx.workspaceId, fx.alice.id))?.role).toBe("member")
      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "invitation.accepted", targetId: fx.invitationId, workspaceId: fx.workspaceId })
      )

      expect((await acceptRequest(fx.invitationId)).status).toBe(404)
      expect(await (await listRequest()).json()).toEqual({ invitations: [] })
    })

    it("rejects a revoked invitation", async () => {
      await fx.store.revokeInvitation(fx.workspaceId, fx.invitationId)
      session = { user: fx.alice, memberships: [] }

      expect(await (await listRequest()).json()).toEqual({ invitations: [] })
      expect((await acceptRequest(fx.invitationId)).status).toBe(404)
    })

    it("rejects an expired invitation without extending it", async () => {
      await expect(
        acceptInvitationById(
          fx.store,
          { workspaceId: fx.workspaceId, invitationId: fx.invitationId, user: fx.alice },
          Date.now() + 365 * 86_400_000
        )
      ).rejects.toMatchObject({ code: "invitation_invalid" })
      expect(await fx.store.getMembership(fx.workspaceId, fx.alice.id)).toBeUndefined()
    })
  })
}
