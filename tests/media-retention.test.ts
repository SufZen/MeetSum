import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  retentionDays: 30,
}))

vi.mock("@/lib/settings/app-settings", () => ({
  getAppSettings: vi.fn(async () => ({ audioRetentionDays: mocks.retentionDays })),
}))

vi.mock("@/lib/storage/object-storage", () => ({
  deleteMeetingObject: vi.fn(),
}))

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }))

const { applyMediaRetention, planMediaRetention } = await import("@/lib/storage/retention")

const now = new Date("2026-10-12T00:00:00.000Z")

function candidateRows() {
  return [
    {
      id: "asset_old",
      meeting_id: "meet_1",
      storage_key: "meetings/meet_1/old.m4a",
      content_type: "audio/mp4",
      size_bytes: "1000",
      created_at: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "asset_video",
      meeting_id: "meet_2",
      storage_key: "meetings/meet_2/old.mp4",
      content_type: "video/mp4",
      size_bytes: 5000,
      created_at: new Date("2026-08-02T00:00:00.000Z"),
    },
  ]
}

function database(rows = candidateRows()) {
  return {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      void values
      return /from media_assets a/.test(sql) ? { rows } : { rows: [] }
    }),
  }
}

beforeEach(() => {
  mocks.retentionDays = 30
})

describe("planMediaRetention", () => {
  it("selects media of completed meetings of one workspace older than the window", async () => {
    const db = database()

    const plan = await planMediaRetention({ workspaceId: "ws_1", db, now })

    const [sql, values] = db.query.mock.calls[0]
    expect(sql).toMatch(/m\.workspace_id = \$1/)
    expect(sql).toMatch(/a\.workspace_id = \$1/)
    expect(sql).toMatch(/m\.status = 'completed'/)
    expect(sql).toMatch(/a\.created_at < \$2/)
    expect(values).toEqual(["ws_1", "2026-09-12T00:00:00.000Z", 500])
    expect(plan).toMatchObject({
      workspaceId: "ws_1",
      retentionDays: 30,
      totalBytes: 6000,
    })
    expect(plan.candidates.map((item) => item.id)).toEqual(["asset_old", "asset_video"])
  })

  it("uses each workspace's own audioRetentionDays", async () => {
    mocks.retentionDays = 7
    const db = database()

    await planMediaRetention({ workspaceId: "ws_2", db, now })

    expect(db.query.mock.calls[0][1]).toEqual(["ws_2", "2026-10-05T00:00:00.000Z", 500])
  })

  it("keeps everything when retention is 0 (disabled)", async () => {
    mocks.retentionDays = 0
    const db = database()

    const plan = await planMediaRetention({ workspaceId: "ws_1", db, now })

    expect(plan.candidates).toEqual([])
    expect(db.query).not.toHaveBeenCalled()
  })

  it("requires a workspace", async () => {
    await expect(
      planMediaRetention({ workspaceId: "", db: database(), now })
    ).rejects.toThrow(/workspaceId/)
  })
})

describe("applyMediaRetention", () => {
  it("is a dry run unless execute is set", async () => {
    const db = database()
    const deleteObject = vi.fn()

    const result = await applyMediaRetention({ workspaceId: "ws_1", db, now, deleteObject })

    expect(result).toMatchObject({ dryRun: true, candidates: 2, deleted: 0 })
    expect(deleteObject).not.toHaveBeenCalled()
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it("deletes objects then rows (keeping transcripts) and audits the run", async () => {
    const db = database()
    const deleteObject = vi.fn()
    const audit = vi.fn(async () => undefined)

    const result = await applyMediaRetention({
      workspaceId: "ws_1",
      execute: true,
      db,
      now,
      deleteObject,
      audit,
    })

    expect(deleteObject.mock.calls.map(([key]) => key)).toEqual([
      "meetings/meet_1/old.m4a",
      "meetings/meet_2/old.mp4",
    ])
    const deletes = db.query.mock.calls.filter(([sql]) => /delete from/.test(sql as string))
    expect(deletes.map(([sql]) => sql)).toEqual([
      "delete from media_assets where id = $1 and workspace_id = $2",
      "delete from media_assets where id = $1 and workspace_id = $2",
    ])
    expect(deletes.map(([, values]) => values)).toEqual([
      ["asset_old", "ws_1"],
      ["asset_video", "ws_1"],
    ])
    expect(result).toMatchObject({ deleted: 2, deletedBytes: 6000, errors: [] })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        action: "media.retention.deleted",
        metadata: expect.objectContaining({ deleted: 2, retentionDays: 30 }),
      })
    )
  })

  it("keeps the row when the object cannot be deleted", async () => {
    const db = database()
    const deleteObject = vi
      .fn()
      .mockRejectedValueOnce(new Error("S3 down"))
      .mockResolvedValueOnce(undefined)

    const result = await applyMediaRetention({
      workspaceId: "ws_1",
      execute: true,
      db,
      now,
      deleteObject,
      audit: vi.fn(async () => undefined),
    })

    expect(result.deleted).toBe(1)
    expect(result.errors).toEqual(["asset_old: S3 down"])
    const deletes = db.query.mock.calls.filter(([sql]) => /delete from/.test(sql as string))
    expect(deletes.map(([, values]) => (values as unknown as string[])[0])).toEqual([
      "asset_video",
    ])
  })
})
