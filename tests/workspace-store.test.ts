import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  WorkspaceStoreError,
  createInMemoryWorkspaceStore,
  createPostgresWorkspaceStore,
  type WorkspaceStore,
} from "@/lib/workspaces/store"
import {
  createInvitationToken,
  getInviteTtlHours,
  hashInvitationToken,
  isInvitationTokenShape,
} from "@/lib/workspaces/tokens"

import { addMember, seedWorkspace } from "./helpers/workspace-auth"

describe("invitation tokens", () => {
  it("are inv_ + 32 random bytes (base64url) and hashed with sha256", () => {
    const token = createInvitationToken()

    expect(token).toMatch(/^inv_[A-Za-z0-9_-]{43}$/)
    expect(isInvitationTokenShape(token)).toBe(true)
    expect(isInvitationTokenShape("inv_short")).toBe(false)
    expect(hashInvitationToken(token)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashInvitationToken(token)).not.toContain(token)
    expect(createInvitationToken()).not.toBe(token)
  })

  it("default to a 168h TTL, overridable by MEETSUM_INVITE_TTL_HOURS", () => {
    expect(getInviteTtlHours({} as NodeJS.ProcessEnv)).toBe(168)
    expect(getInviteTtlHours({ MEETSUM_INVITE_TTL_HOURS: "24" } as unknown as NodeJS.ProcessEnv)).toBe(24)
    expect(getInviteTtlHours({ MEETSUM_INVITE_TTL_HOURS: "x" } as unknown as NodeJS.ProcessEnv)).toBe(168)
  })
})

describe("in-memory WorkspaceStore", () => {
  let store: WorkspaceStore

  beforeEach(() => {
    store = createInMemoryWorkspaceStore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("normalises user emails and upserts idempotently", async () => {
    const first = await store.upsertUser({ email: " Alice@Example.COM ", name: "Alice" })
    const second = await store.upsertUser({ email: "alice@example.com", login: true })

    expect(first.email).toBe("alice@example.com")
    expect(second.id).toBe(first.id)
    expect(second.name).toBe("Alice")
    expect(second.lastLoginAt).toBeTruthy()
  })

  it("creates a workspace with the creator as owner", async () => {
    const { owner, workspace } = await seedWorkspace(store, "Acme", "owner@example.com")

    expect(workspace.slug).toBe("acme")
    expect(await store.getMembership(workspace.id, owner.id)).toMatchObject({ role: "owner" })
    expect((await store.listMembershipsForUser(owner.id)).map((m) => m.workspace.name)).toEqual([
      "Acme",
    ])
  })

  it("guards the last owner on demotion and removal, but allows it with a second owner", async () => {
    const { owner, workspace } = await seedWorkspace(store, "Acme", "owner@example.com")

    await expect(
      store.setMemberRole({ workspaceId: workspace.id, userId: owner.id, role: "admin" })
    ).rejects.toMatchObject({ code: "last_owner", status: 409 })
    await expect(
      store.removeMember({ workspaceId: workspace.id, userId: owner.id })
    ).rejects.toBeInstanceOf(WorkspaceStoreError)

    const second = await addMember(store, workspace.id, "second@example.com", "owner")

    await store.setMemberRole({ workspaceId: workspace.id, userId: owner.id, role: "admin" })
    await expect(
      store.removeMember({ workspaceId: workspace.id, userId: second.id })
    ).rejects.toMatchObject({ code: "last_owner" })
  })

  it("re-inviting revokes the older pending invitation", async () => {
    const { workspace } = await seedWorkspace(store, "Acme", "owner@example.com")
    const first = await store.createInvitation({
      workspaceId: workspace.id,
      email: "Invitee@Example.com",
      role: "member",
    })
    const second = await store.createInvitation({
      workspaceId: workspace.id,
      email: "invitee@example.com",
      role: "viewer",
    })
    const list = await store.listInvitations(workspace.id)

    expect(list.find((i) => i.id === first.invitation.id)?.status).toBe("revoked")
    expect(list.find((i) => i.id === second.invitation.id)?.status).toBe("pending")
    expect(await store.findInvitationByToken(first.token)).toMatchObject({
      invitation: { status: "revoked" },
    })
  })

  it("accepts only for the matching email, idempotently, and sets the default workspace", async () => {
    const { workspace } = await seedWorkspace(store, "Acme", "owner@example.com")
    const { token } = await store.createInvitation({
      workspaceId: workspace.id,
      email: "invitee@example.com",
      role: "member",
    })
    const stranger = await store.upsertUser({ email: "stranger@example.com" })
    const invitee = await store.upsertUser({ email: "invitee@example.com" })

    await expect(store.acceptInvitation({ token, user: stranger })).rejects.toMatchObject({
      code: "email_mismatch",
      status: 403,
    })

    const accepted = await store.acceptInvitation({ token, user: invitee })
    const again = await store.acceptInvitation({ token, user: invitee })

    expect(accepted.membership.role).toBe("member")
    expect(again.membership.role).toBe("member")
    expect((await store.getUserById(invitee.id))?.defaultWorkspaceId).toBe(workspace.id)
    await expect(store.acceptInvitation({ token, user: stranger })).rejects.toMatchObject({
      code: "invitation_invalid",
    })
  })

  it("never downgrades an existing member who accepts a lower-role invite", async () => {
    const { workspace } = await seedWorkspace(store, "Acme", "owner@example.com")
    const admin = await addMember(store, workspace.id, "admin@example.com", "admin")
    const { token } = await store.createInvitation({
      workspaceId: workspace.id,
      email: "admin@example.com",
      role: "viewer",
    })

    await store.acceptInvitation({ token, user: admin })
    expect(await store.getMembership(workspace.id, admin.id)).toMatchObject({ role: "admin" })
  })

  it("rejects expired and revoked invitations", async () => {
    const { workspace } = await seedWorkspace(store, "Acme", "owner@example.com")
    const user = await store.upsertUser({ email: "late@example.com" })
    const expired = await store.createInvitation({
      workspaceId: workspace.id,
      email: "late@example.com",
      role: "member",
      ttlHours: -1,
    })

    expect((await store.findInvitationByToken(expired.token))?.invitation.status).toBe("expired")
    await expect(store.acceptInvitation({ token: expired.token, user })).rejects.toMatchObject({
      code: "invitation_invalid",
    })

    const revoked = await store.createInvitation({
      workspaceId: workspace.id,
      email: "late@example.com",
      role: "member",
    })

    await store.revokeInvitation(workspace.id, revoked.invitation.id)
    await expect(store.acceptInvitation({ token: revoked.token, user })).rejects.toMatchObject({
      code: "invitation_invalid",
    })
  })

  it("rotates the token on resend (old link dies) and records send attempts", async () => {
    const { workspace } = await seedWorkspace(store, "Acme", "owner@example.com")
    const created = await store.createInvitation({
      workspaceId: workspace.id,
      email: "invitee@example.com",
      role: "member",
    })
    const rotated = await store.rotateInvitationToken(workspace.id, created.invitation.id)

    expect(rotated.token).not.toBe(created.token)
    expect(await store.findInvitationByToken(created.token)).toBeUndefined()
    expect(await store.findInvitationByToken(rotated.token)).toBeTruthy()

    await store.recordInvitationSend(created.invitation.id, { error: "smtp down" })
    await store.recordInvitationSend(created.invitation.id, { error: null })

    const invitation = await store.getInvitation(workspace.id, created.invitation.id)

    expect(invitation?.sendCount).toBe(2)
    expect(invitation?.lastSendError).toBeUndefined()
  })

  it("scopes invitation management to the workspace", async () => {
    const a = await seedWorkspace(store, "A", "a@example.com")
    const b = await seedWorkspace(store, "B", "b@example.com")
    const { invitation } = await store.createInvitation({
      workspaceId: a.workspace.id,
      email: "x@example.com",
      role: "member",
    })

    expect(await store.getInvitation(b.workspace.id, invitation.id)).toBeUndefined()
    await expect(store.revokeInvitation(b.workspace.id, invitation.id)).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(store.rotateInvitationToken(b.workspace.id, invitation.id)).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("updates name and google subject", async () => {
    const { workspace } = await seedWorkspace(store, "Acme", "owner@example.com")
    const updated = await store.updateWorkspace(workspace.id, {
      name: "Acme 2",
      googleSubject: "Owner@Example.com",
    })

    expect(updated).toMatchObject({ name: "Acme 2", googleSubject: "owner@example.com" })
    expect(
      (await store.updateWorkspace(workspace.id, { googleSubject: null })).googleSubject
    ).toBeUndefined()
  })
})

type Call = { text: string; values: unknown[] }

function scriptedDb(responses: Array<(call: Call) => unknown[] | undefined>) {
  const calls: Call[] = []

  return {
    calls,
    db: {
      async query(text: string, values: unknown[] = []) {
        const call = { text: text.replace(/\s+/g, " ").trim(), values }

        calls.push(call)

        for (const respond of responses) {
          const rows = respond(call)

          if (rows) return { rows }
        }

        return { rows: [] }
      },
    },
  }
}

describe("postgres WorkspaceStore", () => {
  it("locks owner rows FOR UPDATE inside a transaction before demoting", async () => {
    const owner = { workspace_id: "ws_a", user_id: "usr_1", role: "owner" }
    const { db, calls } = scriptedDb([
      (call) => (call.text.includes("role = 'owner' for update") ? [owner] : undefined),
      (call) => (call.text.includes("user_id = $2 for update") ? [owner] : undefined),
    ])
    const store = createPostgresWorkspaceStore(db)

    await expect(
      store.setMemberRole({ workspaceId: "ws_a", userId: "usr_1", role: "admin" })
    ).rejects.toMatchObject({ code: "last_owner" })

    expect(calls[0].text).toBe("begin")
    expect(calls.some((call) => /for update/.test(call.text))).toBe(true)
    expect(calls.some((call) => call.text.startsWith("update memberships"))).toBe(false)
    expect(calls.at(-1)?.text).toBe("rollback")
  })

  it("stores only the token hash and revokes older pending invites in the same transaction", async () => {
    const { db, calls } = scriptedDb([
      (call) =>
        call.text.startsWith("insert into invitations")
          ? [
              {
                id: "inv_1",
                workspace_id: "ws_a",
                email: "x@example.com",
                role: "member",
                status: "pending",
                expires_at: new Date(Date.now() + 3_600_000),
                send_count: 0,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ]
          : undefined,
    ])
    const store = createPostgresWorkspaceStore(db)
    const { token, invitation } = await store.createInvitation({
      workspaceId: "ws_a",
      email: "X@Example.com",
      role: "member",
    })
    const insert = calls.find((call) => call.text.startsWith("insert into invitations"))

    expect(calls.map((call) => call.text.split(" ")[0])).toEqual([
      "begin",
      "update",
      "insert",
      "commit",
    ])
    expect(calls[1].text).toMatch(/status = 'revoked'.*status = 'pending'/)
    expect(insert?.values).toContain(hashInvitationToken(token))
    expect(insert?.values).not.toContain(token)
    expect(insert?.values).toContain("x@example.com")
    expect(invitation.status).toBe("pending")
  })

  it("accepts with a row lock and refuses a mismatched email", async () => {
    const { db, calls } = scriptedDb([
      (call) =>
        call.text.includes("for update of i")
          ? [
              {
                id: "inv_1",
                workspace_id: "ws_a",
                email: "invitee@example.com",
                role: "member",
                status: "pending",
                expires_at: new Date(Date.now() + 3_600_000),
                send_count: 1,
                created_at: new Date(),
                updated_at: new Date(),
                w_id: "ws_a",
                w_name: "A",
                w_slug: "a",
                w_google_subject: null,
              },
            ]
          : undefined,
    ])
    const store = createPostgresWorkspaceStore(db)

    await expect(
      store.acceptInvitation({
        token: createInvitationToken(),
        user: { id: "usr_x", email: "other@example.com" },
      })
    ).rejects.toMatchObject({ code: "email_mismatch" })
    expect(calls.some((call) => call.text.startsWith("insert into memberships"))).toBe(false)
  })

  it("filters memberships to live (not deleted) workspaces", async () => {
    const { db, calls } = scriptedDb([])

    await createPostgresWorkspaceStore(db).listMembershipsForUser("usr_1")
    expect(calls[0].text).toMatch(/w\.deleted_at is null/)
    expect(calls[0].values).toEqual(["usr_1"])
  })
})
