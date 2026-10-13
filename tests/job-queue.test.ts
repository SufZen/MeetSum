import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  close: vi.fn(),
  createJob: vi.fn(),
}))

vi.mock("bullmq", () => ({
  Queue: vi.fn(function Queue() {
    return { add: mocks.add, close: mocks.close }
  }),
}))

vi.mock("@/lib/meetings/store", () => ({
  meetingRepository: { createJob: mocks.createJob },
}))

const { closeMeetSumQueue, enqueueMeetSumJob, getJobAttempts } = await import(
  "@/lib/jobs/queue"
)
const { getCaptureScheduleConfig } = await import("@/lib/jobs/scheduler-config")

beforeEach(() => {
  mocks.add.mockReset().mockResolvedValue({})
  mocks.createJob.mockReset().mockImplementation(async (input) => ({
    id: "job_123",
    ...input,
  }))
})

afterEach(async () => {
  delete process.env.MEETSUM_JOB_ATTEMPTS
  await closeMeetSumQueue()
})

describe("enqueueMeetSumJob", () => {
  it("defaults to 3 attempts with exponential backoff and the record id as jobId", async () => {
    await enqueueMeetSumJob("media.ingest", { meetingId: "meet_1", assetId: "asset_1" })

    expect(mocks.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: "media.ingest", meetingId: "meet_1", maxAttempts: 3 })
    )
    expect(mocks.add).toHaveBeenCalledWith(
      "media.ingest",
      { meetingId: "meet_1", assetId: "asset_1", jobRecordId: "job_123" },
      expect.objectContaining({
        jobId: "job_123",
        attempts: 3,
        backoff: { type: "exponential", delay: 3000 },
      })
    )
  })

  it("reads attempts from MEETSUM_JOB_ATTEMPTS and persists them as maxAttempts", async () => {
    process.env.MEETSUM_JOB_ATTEMPTS = "5"

    await enqueueMeetSumJob("meeting.summarize", { meetingId: "meet_2" })

    expect(mocks.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ maxAttempts: 5 })
    )
    expect(mocks.add.mock.calls[0][2]).toMatchObject({ attempts: 5, jobId: "job_123" })
  })

  it("ignores invalid attempt values", () => {
    expect(getJobAttempts({ MEETSUM_JOB_ATTEMPTS: "0" })).toBe(3)
    expect(getJobAttempts({ MEETSUM_JOB_ATTEMPTS: "abc" })).toBe(3)
    expect(getJobAttempts({ MEETSUM_JOB_ATTEMPTS: "1" })).toBe(1)
  })
})

describe("getCaptureScheduleConfig", () => {
  it("renews Teams subscriptions every 360 minutes by default", () => {
    expect(getCaptureScheduleConfig({}).teamsSubscriptionRenew.minutes).toBe(360)
    expect(
      getCaptureScheduleConfig({ MEETSUM_TEAMS_SUBSCRIPTION_RENEW_MINUTES: "60" })
        .teamsSubscriptionRenew.minutes
    ).toBe(60)
  })
})
