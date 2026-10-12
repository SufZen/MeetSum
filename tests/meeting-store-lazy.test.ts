import { afterEach, describe, expect, it, vi } from "vitest"

describe("meeting repository store", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("does not resolve the backend at import time (next build safety)", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("MEETSUM_STORAGE", "")
    vi.stubEnv("MEETSUM_ALLOW_DEMO_STORAGE", "")

    const store = await import("@/lib/meetings/store")

    // Misconfiguration surfaces on first use, not on module load.
    expect(() => store.getSystemMeetingRepository("ws_default")).toThrow(
      /MEETSUM_STORAGE must be "postgres"/
    )
  })

  it("builds scoped repositories over one shared backend", async () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("MEETSUM_STORAGE", "memory")

    const store = await import("@/lib/meetings/store")
    const w1 = store.getSystemMeetingRepository("ws_one")
    const w2 = store.getSystemMeetingRepository("ws_two")
    const created = await w1.createMeeting({
      title: "Scoped",
      startedAt: new Date().toISOString(),
      source: "upload",
      language: "en",
      participants: [],
    })

    expect(w1).not.toBe(w2)
    expect(await w1.getMeeting(created.id)).toBeDefined()
    expect(await w2.getMeeting(created.id)).toBeUndefined()
  })
})
