/**
 * M9 Integration: `/[locale]/invite/accept?id=…` (the `invited` notification
 * target). Signed in only; renders only an invitation addressed to the
 * session email; everything else is the same 404 as the accept API.
 */
import { isValidElement, type ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let auth:
  | { status: "unauthenticated" }
  | { status: "no_workspace"; session: { user: { id: string; email: string }; memberships: never[] } } = {
  status: "unauthenticated",
}

vi.mock("@/lib/auth/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/authz")>()),
  getServerAuthState: vi.fn(async () => auth),
}))

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND")
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  },
}))

vi.mock("@/lib/users/preferences", () => ({
  getUserPreferences: async () => ({ locale: null, timeZone: null, notifications: { muted: [] } }),
}))

import InviteAcceptByIdPage from "@/app/[locale]/invite/accept/page"
import { createCollabMemoryDb, setCollabBackendForTesting, type CollabBackend } from "@/lib/clips/db"
import { enqueueNotification } from "@/lib/notifications/enqueue"
import { createInMemoryWorkspaceStore, setWorkspaceStoreForTesting } from "@/lib/workspaces/store"

type User = { id: string; email: string }

let invitationId = ""
let alice: User
let bob: User

const render = (id: string | undefined, locale = "he") =>
  InviteAcceptByIdPage({
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve(id === undefined ? {} : { id }),
  })

beforeEach(async () => {
  const store = createInMemoryWorkspaceStore({ seedDefaultWorkspace: false })
  const backend: CollabBackend = { kind: "memory", db: createCollabMemoryDb() }

  setWorkspaceStoreForTesting(store)
  setCollabBackendForTesting(backend)

  const owner = await store.upsertUser({ email: "owner@acme.example", name: "Owner Name" })
  const a = await store.upsertUser({ email: "alice@acme.example", name: "Alice" })
  const b = await store.upsertUser({ email: "bob@acme.example", name: "Bob" })
  const workspace = await store.createWorkspace({ name: "Acme", createdByUserId: owner.id })
  const { invitation } = await store.createInvitation({
    workspaceId: workspace.id,
    email: "Alice@ACME.example",
    role: "member",
    invitedByUserId: owner.id,
  })

  await enqueueNotification(
    {
      workspaceId: workspace.id,
      userId: a.id,
      kind: "invited",
      payload: { invitationId: invitation.id, workspaceId: workspace.id, role: "member" },
    },
    backend
  )
  invitationId = invitation.id
  alice = { id: a.id, email: a.email }
  bob = { id: b.id, email: b.email }
})

afterEach(() => {
  auth = { status: "unauthenticated" }
  setWorkspaceStoreForTesting(undefined)
  setCollabBackendForTesting(undefined)
})

describe("invite/accept page", () => {
  it("sends a signed-out visitor to login with a safe returnTo", async () => {
    await expect(render(invitationId)).rejects.toThrow(
      `NEXT_REDIRECT:/he/login?returnTo=${encodeURIComponent(`/he/invite/accept?id=${invitationId}`)}`
    )
  })

  it("renders the invitee's own invitation with workspace and inviter names only", async () => {
    auth = { status: "no_workspace", session: { user: alice, memberships: [] } }

    const element = (await render(invitationId)) as ReactElement<Record<string, unknown>>

    expect(isValidElement(element)).toBe(true)
    expect(element.props).toEqual({ id: invitationId, locale: "he", workspaceName: "Acme", inviterName: "Owner Name" })
  })

  it("404s for someone else's, an unknown or a malformed id", async () => {
    auth = { status: "no_workspace", session: { user: bob, memberships: [] } }
    await expect(render(invitationId)).rejects.toThrow("NEXT_NOT_FOUND")

    auth = { status: "no_workspace", session: { user: alice, memberships: [] } }
    await expect(render("inv_doesnotexist")).rejects.toThrow("NEXT_NOT_FOUND")
    await expect(render("../etc")).rejects.toThrow("NEXT_NOT_FOUND")
    await expect(render(undefined)).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("never trusts a mismatched session email on the invitee's user id", async () => {
    auth = { status: "no_workspace", session: { user: { id: alice.id, email: "mallory@acme.example" }, memberships: [] } }

    await expect(render(invitationId)).rejects.toThrow("NEXT_NOT_FOUND")
  })
})
