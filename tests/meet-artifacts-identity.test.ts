import { beforeEach, describe, expect, it, vi } from "vitest"

const query = vi.fn()

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({ query }),
}))

// lib/google/meet-artifacts transitively imports googleapis, BullMQ and the
// AWS S3 SDK through these modules. Loading them took ~1s in isolation and
// blew past the 5s test timeout under a parallel `vitest run`. The identity
// persistence logic under test only touches the database, so stub them out.
vi.mock("@/lib/google/auth", () => ({
  createDelegatedGoogleClient: vi.fn(),
}))

vi.mock("@/lib/google/services", () => ({
  importDriveRecordings: vi.fn(),
}))

describe("Meet artifact identity persistence", () => {
  beforeEach(() => {
    query.mockReset()
  })

  it("returns the persisted Google identity id when the subject already exists", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "gident_existing_calendar_id" }] })

    const { getMeetGoogleIdentityId } = await import("@/lib/google/meet-artifacts")

    await expect(
      getMeetGoogleIdentityId({
        subject: "info@realization.co.il",
        workspaceId: "ws_default",
      })
    ).resolves.toBe("gident_existing_calendar_id")
  })

  it("keeps the legacy account for ws_default and gives other workspaces their own", async () => {
    query.mockResolvedValue({ rows: [] })

    const { ensureGoogleIdentity } = await import("@/lib/google/identity")

    const legacy = await ensureGoogleIdentity({
      subject: "Info@Realization.co.il",
      workspaceId: "ws_default",
    })
    const other = await ensureGoogleIdentity({
      subject: "info@realization.co.il",
      workspaceId: "ws_2",
    })

    const identityInserts = query.mock.calls.filter(([sql]) =>
      /insert into google_identities/.test(sql as string)
    )
    expect(identityInserts[0][1]).toEqual([
      legacy,
      "workspace_realization",
      "info@realization.co.il",
      "ws_default",
    ])
    expect(identityInserts[1][1]).toEqual([
      other,
      "wsacct_ws_2",
      "info@realization.co.il",
      "ws_2",
    ])
    expect(other).not.toBe(legacy)
    expect(identityInserts[0][0]).toMatch(/workspace_id = excluded.workspace_id/)
  })
})
