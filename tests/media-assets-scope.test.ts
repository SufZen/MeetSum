import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  deleteMeetingObject: vi.fn(),
}))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({ query: mocks.query }),
}))

vi.mock("@/lib/storage/object-storage", () => ({
  deleteMeetingObject: mocks.deleteMeetingObject,
}))

const { deleteMediaAsset, listMediaAssets, MediaAssetNotFoundError } = await import(
  "@/lib/storage/media-assets"
)

// An admin of W1: admins do NOT bypass private meetings.
const ADMIN_W1 = {
  kind: "member" as const,
  workspaceId: "ws_1",
  userId: "usr_admin",
  email: "admin@w1.test",
  role: "admin" as const,
}

const assetRow = {
  id: "asset_1",
  meeting_id: "meet_1",
  meeting_title: "Weekly",
  storage_key: "meetings/meet_1/a.m4a",
  filename: "a.m4a",
  content_type: "audio/mp4",
  size_bytes: "100",
  retention: "audio",
  created_at: "2026-10-12T10:00:00.000Z",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("MEETSUM_STORAGE", "postgres")
  mocks.query.mockResolvedValue({ rows: [] })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("storage media assets honour meeting visibility", () => {
  it("lists only assets of meetings the admin can see (private needs owner/participant)", async () => {
    await listMediaAssets(ADMIN_W1, { limit: 10 })

    const [sql, values] = mocks.query.mock.calls[0]
    expect(sql).toMatch(/a\.workspace_id = \$1/)
    expect(sql).toMatch(/m\.workspace_id = \$2/)
    expect(sql).toMatch(/m\.visibility in \('workspace', 'link'\)/)
    expect(sql).toMatch(/m\.owner_user_id = \$3/)
    expect(sql).toMatch(/lower\(mp_scope\.email\) = \$4/)
    expect(values).toEqual(["ws_1", "ws_1", "usr_admin", "admin@w1.test", 10])
  })

  it("never lists another workspace's assets", async () => {
    await listMediaAssets({ ...ADMIN_W1, workspaceId: "ws_2" })

    const [, values] = mocks.query.mock.calls[0]
    expect(values.slice(0, 2)).toEqual(["ws_2", "ws_2"])
  })

  it("treats an asset of an invisible private meeting as not found on delete", async () => {
    await expect(deleteMediaAsset(ADMIN_W1, "asset_private")).rejects.toBeInstanceOf(
      MediaAssetNotFoundError
    )

    const [sql, values] = mocks.query.mock.calls[0]
    expect(sql).toMatch(/m\.owner_user_id = \$4/)
    expect(values).toEqual(["asset_private", "ws_1", "ws_1", "usr_admin", "admin@w1.test"])
    expect(mocks.deleteMeetingObject).not.toHaveBeenCalled()
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })

  it("deletes an asset of a visible meeting", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [assetRow] })

    await expect(deleteMediaAsset(ADMIN_W1, "asset_1")).resolves.toMatchObject({
      id: "asset_1",
      sizeBytes: 100,
    })
    expect(mocks.deleteMeetingObject).toHaveBeenCalledWith("meetings/meet_1/a.m4a")
    expect(mocks.query.mock.calls[1]).toEqual([
      "delete from media_assets where id = $1 and workspace_id = $2",
      ["asset_1", "ws_1"],
    ])
  })
})
