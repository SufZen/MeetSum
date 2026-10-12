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
  getWorkspaceSubject: vi.fn(),
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
      getMeetGoogleIdentityId("info@realization.co.il")
    ).resolves.toBe("gident_existing_calendar_id")
  })
})
