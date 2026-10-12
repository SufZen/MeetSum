import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const listAuditLogs = vi.hoisted(() => vi.fn())

vi.mock("@/lib/audit", () => ({ listAuditLogs, recordAuditLog: vi.fn(async () => {}) }))

import { GET } from "@/app/api/admin/audit-logs/route"
import { setWorkspaceStoreForTesting, type WorkspaceStore } from "@/lib/workspaces/store"

import {
  TEST_SESSION_SECRET,
  addMember,
  freshStore,
  makeRequest,
  routeParams,
  seedWorkspace,
  sessionCookieFor,
} from "./helpers/workspace-auth"

const entry = (id: string, createdAt: string) => ({
  id,
  action: "member.removed",
  metadata: {},
  createdAt,
})

describe("GET /api/admin/audit-logs", () => {
  let store: WorkspaceStore

  beforeEach(() => {
    store = freshStore()
    setWorkspaceStoreForTesting(store)
    vi.stubEnv("MEETSUM_SESSION_SECRET", TEST_SESSION_SECRET)
    vi.stubEnv("MEETSUM_RATE_LIMIT", "false")
    listAuditLogs.mockReset()
  })

  afterEach(() => {
    setWorkspaceStoreForTesting(undefined)
    vi.unstubAllEnvs()
  })

  it("requires audit:read (admins and owners)", async () => {
    const { workspace } = await seedWorkspace(store, "W1", "owner@example.com")
    const member = await addMember(store, workspace.id, "member@example.com", "member")
    const response = await GET(
      makeRequest("http://localhost/api/admin/audit-logs", { cookie: sessionCookieFor(member) }),
      routeParams({})
    )

    expect(response.status).toBe(403)
    expect(listAuditLogs).not.toHaveBeenCalled()
  })

  it("always filters by the caller's workspace and forwards filters + cursor", async () => {
    const { owner, workspace } = await seedWorkspace(store, "W1", "owner@example.com")

    listAuditLogs.mockResolvedValue({ logs: [entry("a1", "2026-10-01T00:00:00Z")], nextCursor: "cur_2" })

    const response = await GET(
      makeRequest(
        "http://localhost/api/admin/audit-logs?workspaceId=ws_other&action=member.removed&actor=x%40example.com&targetType=user&targetId=usr_1&before=cur_1&limit=500",
        { cookie: sessionCookieFor(owner) }
      ),
      routeParams({})
    )

    expect(listAuditLogs).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      action: "member.removed",
      actor: "x@example.com",
      targetType: "user",
      targetId: "usr_1",
      before: "cur_1",
      limit: 200,
    })
    expect(await response.json()).toEqual({
      logs: [entry("a1", "2026-10-01T00:00:00Z")],
      nextCursor: "cur_2",
    })
  })

  it("derives a cursor when the store returns a plain page", async () => {
    const { owner } = await seedWorkspace(store, "W1", "owner@example.com")

    listAuditLogs.mockResolvedValue([entry("a1", "2026-10-02T00:00:00Z"), entry("a2", "2026-10-01T00:00:00Z")])

    const full = await GET(
      makeRequest("http://localhost/api/admin/audit-logs?limit=2", { cookie: sessionCookieFor(owner) }),
      routeParams({})
    )

    expect((await full.json()).nextCursor).toBe("2026-10-01T00:00:00Z")

    listAuditLogs.mockResolvedValue([entry("a1", "2026-10-02T00:00:00Z")])

    const partial = await GET(
      makeRequest("http://localhost/api/admin/audit-logs?limit=2", { cookie: sessionCookieFor(owner) }),
      routeParams({})
    )

    expect((await partial.json()).nextCursor).toBeNull()
  })
})
