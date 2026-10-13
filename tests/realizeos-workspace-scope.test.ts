import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getMeeting: vi.fn(),
  repositoryWorkspaces: [] as string[],
  recordAuditLog: vi.fn(),
  deliverWebhookEvent: vi.fn(),
}))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({ query: mocks.query }),
}))

vi.mock("@/lib/meetings/store", () => ({
  getSystemMeetingRepository: (workspaceId: string) => {
    mocks.repositoryWorkspaces.push(workspaceId)
    return { getMeeting: mocks.getMeeting }
  },
}))

vi.mock("@/lib/audit", () => ({ recordAuditLog: mocks.recordAuditLog }))

vi.mock("@/lib/webhooks/delivery", () => ({
  deliverWebhookEvent: mocks.deliverWebhookEvent,
}))

const {
  exportMeetingToRealizeOS,
  listRealizeOSExports,
  RealizeOSExportNotFoundError,
  retryRealizeOSExport,
} = await import("@/lib/integrations/realizeos")

const adminW1 = {
  kind: "member" as const,
  workspaceId: "ws_1",
  userId: "usr_admin",
  email: "Admin@W1.test",
  role: "admin" as const,
}

const meeting = {
  id: "meet_1",
  title: "Weekly",
  source: "upload",
  language: "he",
  status: "completed",
  retention: "audio",
  startedAt: "2026-10-12T10:00:00.000Z",
  participants: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.repositoryWorkspaces.length = 0
  vi.stubEnv("MEETSUM_STORAGE", "postgres")
  vi.stubEnv("REALIZEOS_API_URL", "https://realizeos.example.test")
  mocks.query.mockResolvedValue({ rows: [] })
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("RealizeOS exports are workspace-scoped", () => {
  it("lists only exports whose meeting is in the workspace", async () => {
    await listRealizeOSExports({ kind: "system", workspaceId: "ws_2" }, {
      meetingId: "meet_1",
    })

    const [sql, values] = mocks.query.mock.calls[0]
    expect(sql).toMatch(/join meetings m on m\.id = s\.meeting_id/)
    expect(sql).toMatch(/m\.workspace_id = \$2/)
    expect(values).toEqual(["realizeos", "ws_2", "meet_1", 25])
  })

  it("applies the caller's private-meeting visibility to listed exports", async () => {
    await listRealizeOSExports(adminW1)

    const [sql, values] = mocks.query.mock.calls[0]
    expect(sql).toMatch(/m\.workspace_id = \$2/)
    expect(sql).toMatch(/m\.visibility in \('workspace', 'link'\)/)
    expect(sql).toMatch(/m\.owner_user_id = \$3/)
    expect(sql).toMatch(/lower\(mp_scope\.email\) = \$4/)
    expect(values).toEqual(["realizeos", "ws_1", "usr_admin", "admin@w1.test", 25])
  })

  it("restricts an API key to shared meetings plus its creator's private ones", async () => {
    await listRealizeOSExports({
      kind: "api_key",
      workspaceId: "ws_1",
      ownerUserId: "usr_key",
    })

    const [sql, values] = mocks.query.mock.calls[0]
    expect(sql).toMatch(/m\.visibility = 'private' and m\.owner_user_id = \$3/)
    expect(values).toEqual(["realizeos", "ws_1", "usr_key", 25])
  })

  it("treats another workspace's export as not found on retry", async () => {
    await expect(
      retryRealizeOSExport({ kind: "system", workspaceId: "ws_2" }, "sar_w1")
    ).rejects.toBeInstanceOf(RealizeOSExportNotFoundError)
    const [sql, values] = mocks.query.mock.calls[0]
    expect(sql).toMatch(/m\.workspace_id = \$2/)
    expect(values).toEqual(["sar_w1", "ws_2"])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("treats an export of an invisible private meeting as not found on retry", async () => {
    // The visibility predicate filters the row out: nothing is re-sent.
    await expect(retryRealizeOSExport(adminW1, "sar_private")).rejects.toBeInstanceOf(
      RealizeOSExportNotFoundError
    )
    const [sql, values] = mocks.query.mock.calls[0]
    expect(sql).toMatch(/m\.owner_user_id = \$3/)
    expect(sql).toMatch(/mp_scope/)
    expect(values).toEqual(["sar_private", "ws_1", "usr_admin", "admin@w1.test"])
    expect(mocks.getMeeting).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("retries a visible export in the caller's workspace", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: "sar_1", meeting_id: "meet_1" }] })
    mocks.getMeeting.mockResolvedValue(meeting)

    await expect(retryRealizeOSExport(adminW1, "sar_1")).resolves.toMatchObject({
      status: "sent",
      meetingId: "meet_1",
    })
    expect(mocks.repositoryWorkspaces).toEqual(["ws_1"])
  })

  it("never exports a meeting outside the workspace", async () => {
    mocks.getMeeting.mockResolvedValue(undefined)

    await expect(
      exportMeetingToRealizeOS({ meetingId: "meet_w1", workspaceId: "ws_2" })
    ).rejects.toBeInstanceOf(RealizeOSExportNotFoundError)
    expect(mocks.repositoryWorkspaces).toEqual(["ws_2"])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("audits and emits webhooks in the meeting's workspace", async () => {
    mocks.getMeeting.mockResolvedValue(meeting)

    await exportMeetingToRealizeOS({ meetingId: "meet_1", workspaceId: "ws_2" })

    expect(mocks.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_2", action: "realizeos.export.sent" })
    )
    expect(mocks.deliverWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_2", eventName: "realizeos.export.sent" })
    )
  })
})
