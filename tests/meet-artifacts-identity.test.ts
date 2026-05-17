import { beforeEach, describe, expect, it, vi } from "vitest"

const query = vi.fn()

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({ query }),
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
