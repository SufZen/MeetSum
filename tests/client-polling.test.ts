import { describe, expect, it } from "vitest"

import { ACTIVE_POLL_MS, IDLE_POLL_MS, nextPollDelay } from "@/lib/client/polling"

describe("nextPollDelay", () => {
  it("pauses while hidden", () => {
    expect(nextPollDelay({ activeJobs: 3, selectedProcessing: true, hidden: true })).toBeNull()
  })

  it("polls every 5 s while jobs run or the selected meeting processes", () => {
    expect(ACTIVE_POLL_MS).toBe(5_000)
    expect(nextPollDelay({ activeJobs: 1, selectedProcessing: false, hidden: false })).toBe(5_000)
    expect(nextPollDelay({ activeJobs: 0, selectedProcessing: true, hidden: false })).toBe(5_000)
  })

  it("backs off to 60 s when idle", () => {
    expect(IDLE_POLL_MS).toBe(60_000)
    expect(nextPollDelay({ activeJobs: 0, selectedProcessing: false, hidden: false })).toBe(60_000)
  })
})
