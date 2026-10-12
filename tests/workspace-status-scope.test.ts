import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({ query: mocks.query }),
}))

vi.mock("@/lib/google/oauth-tokens", () => ({
  getGoogleWorkspaceOAuthConnectionStatus: vi.fn(async () => ({ connected: false })),
}))

const { getWorkspaceStatus } = await import("@/lib/ops/status")

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("MEETSUM_STORAGE", "postgres")
  mocks.query.mockResolvedValue({ rows: [] })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("getWorkspaceStatus", () => {
  it("reads sync states and job counts of the workspace only", async () => {
    await getWorkspaceStatus({ workspaceId: "ws_2", googleSubject: "owner@w2.test" })

    expect(mocks.query).toHaveBeenCalledTimes(2)
    for (const [sql, values] of mocks.query.mock.calls) {
      expect(sql).toMatch(/workspace_id = \$1/)
      expect(values).toEqual(["ws_2"])
    }
  })

  it("reports the workspace's Google subject, never the env one for other workspaces", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_SUBJECT", "boot@example.test")

    const other = await getWorkspaceStatus({ workspaceId: "ws_2" })
    const own = await getWorkspaceStatus({
      workspaceId: "ws_2",
      googleSubject: "owner@w2.test",
    })
    const legacy = await getWorkspaceStatus({ workspaceId: "ws_default" })

    expect(other.google.subject).toBeNull()
    expect(own.google.subject).toBe("owner@w2.test")
    expect(legacy.google.subject).toBe("boot@example.test")
  })

  it("reads nothing tenant-specific without a workspace (fail closed)", async () => {
    // Runtime guard for untyped callers.
    const status = await getWorkspaceStatus(
      {} as Parameters<typeof getWorkspaceStatus>[0]
    )

    expect(mocks.query).not.toHaveBeenCalled()
    expect(status.sync).toEqual([])
    expect(status.jobs).toEqual({ queued: 0, active: 0, failed: 0 })
  })
})
