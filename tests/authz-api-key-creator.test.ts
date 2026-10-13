import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const keys = vi.hoisted(() => ({ principal: undefined as unknown }))

vi.mock("@/lib/auth/api-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/api-keys")>()),
  resolveEnvApiKey: () => undefined,
  verifyDatabaseApiKey: async () => keys.principal,
}))

import { withAuthz, type AuthContext, type Permission } from "@/lib/auth/authz"
import { setWorkspaceStoreForTesting, type WorkspaceStore } from "@/lib/workspaces/store"

import {
  TEST_SESSION_SECRET,
  addMember,
  freshStore,
  makeRequest,
  routeParams,
  seedWorkspace,
} from "./helpers/workspace-auth"

describe("database API keys follow their creator", () => {
  let store: WorkspaceStore
  const seen: AuthContext[] = []
  const call = (permission: Permission) =>
    withAuthz(permission, async (_request, ctx) => {
      seen.push(ctx)
      return Response.json({ role: ctx.role })
    })(makeRequest("http://localhost/api/x", { bearer: "msk_db_key" }), routeParams({}))

  beforeEach(() => {
    store = freshStore()
    setWorkspaceStoreForTesting(store)
    seen.length = 0
    vi.stubEnv("MEETSUM_SESSION_SECRET", TEST_SESSION_SECRET)
    vi.stubEnv("MEETSUM_STORAGE", "memory")
  })

  afterEach(() => {
    setWorkspaceStoreForTesting(undefined)
    vi.unstubAllEnvs()
  })

  async function adminKey() {
    const { workspace } = await seedWorkspace(store, "W1", "owner@example.com")
    const creator = await addMember(store, workspace.id, "admin@example.com", "admin")
    keys.principal = {
      id: "key_1",
      label: "CI",
      workspaceId: workspace.id,
      scopes: ["read", "write", "admin"],
      createdByUserId: creator.id,
    }
    return { workspace, creator }
  }

  it("works with the creator's role while they are an admin member", async () => {
    await adminKey()

    const response = await call("settings:write")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ role: "admin" })
  })

  it("stops working when the creator leaves the workspace", async () => {
    const { workspace, creator } = await adminKey()
    await store.removeMember({ workspaceId: workspace.id, userId: creator.id })

    expect((await call("meeting:read")).status).toBe(401)
  })

  it("is capped at the creator's current role after a demotion", async () => {
    const { workspace, creator } = await adminKey()
    await store.setMemberRole({ workspaceId: workspace.id, userId: creator.id, role: "viewer" })

    expect((await call("settings:write")).status).toBe(403)
    const read = await call("meeting:read")
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ role: "viewer" })
  })
})
