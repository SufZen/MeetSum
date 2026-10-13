import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  close: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  resolveMeetingWorkspaceId: vi.fn(),
  repositoryWorkspaces: [] as string[],
}))

vi.mock("bullmq", () => ({
  Queue: vi.fn(function Queue() {
    return { add: mocks.add, close: mocks.close }
  }),
}))

vi.mock("@/lib/meetings/store", () => ({
  getSystemMeetingRepository: (workspaceId: string) => {
    mocks.repositoryWorkspaces.push(workspaceId)
    return { createJob: mocks.createJob, updateJob: mocks.updateJob }
  },
  resolveMeetingWorkspaceId: mocks.resolveMeetingWorkspaceId,
}))

const { closeMeetSumQueue, enqueueMeetSumJob, getJobAttempts, JobWorkspaceRequiredError, QueueUnavailableError } =
  await import("@/lib/jobs/queue")
/** Untyped call path (legacy payloads): exercises the runtime workspace guard. */
const enqueueUntyped = enqueueMeetSumJob as unknown as (
  name: string,
  payload: Record<string, unknown>
) => ReturnType<typeof enqueueMeetSumJob>
const { getCaptureScheduleConfig, getRetentionScheduleConfig } = await import(
  "@/lib/jobs/scheduler-config"
)

beforeEach(() => {
  mocks.repositoryWorkspaces.length = 0
  mocks.add.mockReset().mockResolvedValue({})
  mocks.updateJob.mockReset().mockResolvedValue({})
  mocks.resolveMeetingWorkspaceId.mockReset().mockResolvedValue("ws_meeting")
  mocks.createJob.mockReset().mockImplementation(async (input) => ({
    id: "job_123",
    ...input,
  }))
})

afterEach(async () => {
  delete process.env.MEETSUM_JOB_ATTEMPTS
  delete process.env.MEETSUM_CAPTURE_WORKSPACE_ID
  await closeMeetSumQueue()
})

describe("enqueueMeetSumJob", () => {
  it("rejects with QueueUnavailableError after the enqueue timeout and fails the job record", async () => {
    vi.useFakeTimers()
    mocks.add.mockReturnValue(new Promise(() => undefined))

    const pending = enqueueMeetSumJob("meeting.summarize", { meetingId: "meet_1", workspaceId: "ws_1" })
    const outcome = pending.catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(await outcome).toBeInstanceOf(QueueUnavailableError)
    expect(mocks.updateJob).toHaveBeenCalledWith("job_123", { status: "failed", error: "queue_unavailable" })
    vi.useRealTimers()
  })

  it("maps an add() rejection to QueueUnavailableError", async () => {
    mocks.add.mockRejectedValue(new Error("ECONNREFUSED"))

    await expect(
      enqueueMeetSumJob("meeting.summarize", { meetingId: "meet_1", workspaceId: "ws_1" })
    ).rejects.toBeInstanceOf(QueueUnavailableError)
  })

  it("defaults to 3 attempts with exponential backoff and the record id as jobId", async () => {
    await enqueueMeetSumJob("media.ingest", {
      meetingId: "meet_1",
      workspaceId: "ws_1",
      assetId: "asset_1",
    })

    expect(mocks.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: "media.ingest", meetingId: "meet_1", maxAttempts: 3 })
    )
    expect(mocks.add).toHaveBeenCalledWith(
      "media.ingest",
      {
        meetingId: "meet_1",
        workspaceId: "ws_1",
        assetId: "asset_1",
        jobRecordId: "job_123",
      },
      expect.objectContaining({
        jobId: "job_123",
        attempts: 3,
        backoff: { type: "exponential", delay: 3000 },
      })
    )
  })

  it("records the job in the payload workspace and persists workspaceId in the payload", async () => {
    await enqueueMeetSumJob("google.calendar.poll", { workspaceId: "ws_2" })

    expect(mocks.repositoryWorkspaces).toEqual(["ws_2"])
    expect(mocks.createJob.mock.calls[0][0].payload).toMatchObject({ workspaceId: "ws_2" })
    expect(mocks.resolveMeetingWorkspaceId).not.toHaveBeenCalled()
  })

  it("resolves the workspace from the meeting when the payload has none", async () => {
    await enqueueUntyped("meeting.summarize", { meetingId: "meet_2" })

    expect(mocks.resolveMeetingWorkspaceId).toHaveBeenCalledWith("meet_2")
    expect(mocks.repositoryWorkspaces).toEqual(["ws_meeting"])
    expect(mocks.add.mock.calls[0][1]).toMatchObject({ workspaceId: "ws_meeting" })
  })

  it("refuses to enqueue a job it cannot attribute to a workspace", async () => {
    mocks.resolveMeetingWorkspaceId.mockResolvedValue(undefined)

    await expect(
      enqueueUntyped("google.drive.poll", { subject: "a@example.test" })
    ).rejects.toBeInstanceOf(JobWorkspaceRequiredError)
    await expect(
      enqueueUntyped("media.ingest", { meetingId: "meet_missing" })
    ).rejects.toBeInstanceOf(JobWorkspaceRequiredError)
    expect(mocks.createJob).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it("attributes Teams subscription renewal to the capture workspace", async () => {
    process.env.MEETSUM_CAPTURE_WORKSPACE_ID = "ws_capture"

    await enqueueMeetSumJob("teams.subscription.renew", { scheduled: true })

    expect(mocks.repositoryWorkspaces).toEqual(["ws_capture"])
  })

  it("reads attempts from MEETSUM_JOB_ATTEMPTS and persists them as maxAttempts", async () => {
    process.env.MEETSUM_JOB_ATTEMPTS = "5"

    await enqueueMeetSumJob("meeting.summarize", { meetingId: "meet_2", workspaceId: "ws_1" })

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

describe("getRetentionScheduleConfig", () => {
  it("only enforces retention when MEETSUM_RETENTION_ENFORCE=true", () => {
    expect(getRetentionScheduleConfig({})).toEqual({ enabled: false, hours: 24 })
    expect(getRetentionScheduleConfig({ MEETSUM_RETENTION_ENFORCE: "true" }).enabled).toBe(
      true
    )
  })
})
