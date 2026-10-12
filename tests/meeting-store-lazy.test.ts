import { afterEach, describe, expect, it, vi } from "vitest"

describe("meeting repository store", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("does not resolve the repository at import time (next build safety)", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("MEETSUM_STORAGE", "")
    vi.stubEnv("MEETSUM_ALLOW_DEMO_STORAGE", "")

    const store = await import("@/lib/meetings/store")

    // Misconfiguration surfaces on first use, not on module load.
    expect(() => store.meetingRepository.listMeetings).toThrow(
      /MEETSUM_STORAGE must be "postgres"/
    )
  })

  it("delegates calls to the resolved repository", async () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("MEETSUM_STORAGE", "memory")

    const store = await import("@/lib/meetings/store")

    expect(store.meetingRepository.listMeetings).toBeTypeOf("function")
    expect(store.getMeetingRepository()).toBe(store.getMeetingRepository())
  })
})
