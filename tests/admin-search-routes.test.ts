import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const mocks = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  reindex: vi.fn(async () => undefined),
  status: vi.fn(),
  workspaceIndexing: vi.fn(),
}))

vi.mock("@/lib/audit", () => ({ recordAuditLog: mocks.audit }))
vi.mock("@/lib/search/index-trigger", () => ({ requestMeetingReindex: mocks.reindex }))
vi.mock("@/lib/search/index-sweep", () => ({
  loadWorkspaceIndexStatus: mocks.status,
  requestWorkspaceIndexing: mocks.workspaceIndexing,
}))

import { POST as reindex } from "@/app/api/admin/search/reindex/route"
import { GET as status } from "@/app/api/admin/search/status/route"
import { setEmbeddingProviderForTesting } from "@/lib/ai/embeddings"
import { createHashEmbeddingProvider } from "@/lib/ai/embeddings/hash"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

const meetings = [
  testMeeting({ id: "m_visible", workspaceId: "ws_a" }),
  testMeeting({ id: "m_private", workspaceId: "ws_a", visibility: "private", ownerUserId: "someone_else" }),
  testMeeting({ id: "m_foreign", workspaceId: "ws_b" }),
]

beforeEach(() => {
  vi.stubEnv("MEETSUM_RATE_LIMIT", "false")
  mocks.audit.mockClear()
  mocks.reindex.mockClear()
  mocks.status.mockReset().mockImplementation(async (_ws: string, key: { model: string; dimensions: number } | null) => ({
    counts: [{ state: "ready", mode: "lexical", count: 3 }],
    total: 3,
    activeKey: key ? `${key.model}:${key.dimensions}` : null,
    activeKeyCoverage: { meetings: 0, ready: 3 },
  }))
  mocks.workspaceIndexing.mockReset().mockResolvedValue({ meetings: 3, sweepQueued: true })
  setEmbeddingProviderForTesting(createHashEmbeddingProvider())
})

afterEach(() => {
  setRouteCtx(undefined)
  setEmbeddingProviderForTesting(undefined)
  vi.unstubAllEnvs()
})

describe("GET /api/admin/search/status", () => {
  it("requires ops:read", async () => {
    setRouteCtx(undefined)
    expect((await status(new Request("http://localhost/api/admin/search/status"), routeParams({}))).status).toBe(401)

    setRouteCtx(await createTestCtx({ role: "member", meetings }))
    expect((await status(new Request("http://localhost/api/admin/search/status"), routeParams({}))).status).toBe(403)
  })

  it("reports the caller's workspace counts, capabilities, mode and active key", async () => {
    setRouteCtx(await createTestCtx({ role: "admin", meetings }))
    const response = await status(new Request("http://localhost/api/admin/search/status"), routeParams({}))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.status).toHaveBeenCalledWith("ws_a", { model: "hash-test", dimensions: 256 })
    expect(body).toMatchObject({
      storage: "memory",
      mode: "lexical",
      total: 3,
      activeKey: "hash-test:256",
      capabilities: {
        vector: { available: false, indexReady: false, reason: "no_database" },
        trgm: { installed: false, hebrew: false },
        embeddingKey: { model: "hash-test", dimensions: 256 },
      },
    })
  })
})

describe("POST /api/admin/search/reindex", () => {
  const url = "http://localhost/api/admin/search/reindex"

  it("requires settings:write", async () => {
    setRouteCtx(await createTestCtx({ role: "member", meetings }))
    const response = await reindex(jsonRequest(url, "POST", { meetingId: "m_visible" }), routeParams({}))

    expect(response.status).toBe(403)
    expect(mocks.reindex).not.toHaveBeenCalled()
  })

  it("re-indexes one visible meeting and audits ids only", async () => {
    setRouteCtx(await createTestCtx({ role: "admin", meetings }))
    const response = await reindex(jsonRequest(url, "POST", { meetingId: "m_visible" }), routeParams({}))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ scope: "meeting", meetingId: "m_visible", meetings: 1 })
    expect(mocks.reindex).toHaveBeenCalledWith({ workspaceId: "ws_a", meetingId: "m_visible", reason: "admin" })
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "search.reindex.requested",
        workspaceId: "ws_a",
        targetType: "meeting",
        targetId: "m_visible",
        metadata: { scope: "meeting" },
      })
    )
  })

  it("answers 404 for private-invisible and foreign meetings", async () => {
    setRouteCtx(await createTestCtx({ role: "admin", meetings }))

    for (const meetingId of ["m_private", "m_foreign", "missing"]) {
      const response = await reindex(jsonRequest(url, "POST", { meetingId }), routeParams({}))

      expect(response.status).toBe(404)
    }
    expect(mocks.reindex).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it("re-indexes the whole workspace without a meetingId", async () => {
    setRouteCtx(await createTestCtx({ role: "owner", meetings }))
    const response = await reindex(jsonRequest(url, "POST", {}), routeParams({}))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ scope: "workspace", meetings: 3, sweepQueued: true })
    expect(mocks.workspaceIndexing).toHaveBeenCalledWith("ws_a")
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "workspace",
        targetId: "ws_a",
        metadata: { scope: "workspace", meetings: 3 },
      })
    )
  })

  it("rejects a malformed meetingId", async () => {
    setRouteCtx(await createTestCtx({ role: "admin", meetings }))

    expect((await reindex(jsonRequest(url, "POST", { meetingId: 42 }), routeParams({}))).status).toBe(400)
    expect((await reindex(jsonRequest(url, "POST", { meetingId: "  " }), routeParams({}))).status).toBe(400)
  })
})
