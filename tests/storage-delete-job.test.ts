import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
}))

vi.mock("bullmq", () => ({
  Queue: vi.fn(function Queue() {
    return { add: mocks.add, close: vi.fn() }
  }),
}))

vi.mock("@/lib/meetings/store", () => ({
  getSystemMeetingRepository: () => ({
    createJob: mocks.createJob,
    updateJob: mocks.updateJob,
  }),
  resolveMeetingWorkspaceId: vi.fn(async () => undefined),
}))

const { DELETE_OBJECTS_BATCH, deleteMeetingObjects } = await import(
  "@/lib/storage/object-storage"
)
const { closeMeetSumQueue, enqueueMeetSumJob, mediaPrepareJobId } = await import(
  "@/lib/jobs/queue"
)

describe("deleteMeetingObjects", () => {
  it("deletes in DeleteObjects batches of 1000 and de-duplicates keys", async () => {
    const keys = Array.from({ length: 2500 }, (_, index) => `meetings/m/${index}`)
    const send = vi.fn(
      async (input: { Bucket: string; Delete: { Objects: Array<{ Key: string }> } }) => {
        void input
        return {}
      }
    )

    const result = await deleteMeetingObjects([...keys, keys[0], ""], { send, bucket: "b" })

    expect(DELETE_OBJECTS_BATCH).toBe(1000)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls.map(([input]) => input.Delete.Objects.length)).toEqual([
      1000, 1000, 500,
    ])
    expect(send.mock.calls[0][0]).toMatchObject({ Bucket: "b", Delete: { Quiet: true } })
    expect(result.deleted).toHaveLength(2500)
    expect(result.failed).toEqual([])
  })

  it("treats NoSuchKey as deleted and reports other per-key errors", async () => {
    const send = vi.fn(async () => ({
      Errors: [
        { Key: "a", Code: "NoSuchKey" },
        { Key: "b", Code: "AccessDenied", Message: "nope" },
      ],
    }))

    await expect(deleteMeetingObjects(["a", "b", "c"], { send, bucket: "b" })).resolves.toEqual({
      deleted: ["a", "c"],
      failed: [{ key: "b", error: "AccessDenied" }],
    })
  })

  it("marks a failed batch request's keys failed and continues with the next batch", async () => {
    const keys = Array.from({ length: 1001 }, (_, index) => `k${index}`)
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("SlowDown"))
      .mockResolvedValueOnce({})

    const result = await deleteMeetingObjects(keys, { send, bucket: "b" })

    expect(result.failed).toHaveLength(1000)
    expect(result.failed[0]).toEqual({ key: "k0", error: "SlowDown" })
    expect(result.deleted).toEqual(["k1000"])
  })

  it("does nothing for an empty list", async () => {
    const send = vi.fn()

    await expect(deleteMeetingObjects([], { send, bucket: "b" })).resolves.toEqual({
      deleted: [],
      failed: [],
    })
    expect(send).not.toHaveBeenCalled()
  })
})

describe("enqueue defaults for M4 jobs", () => {
  beforeEach(() => {
    mocks.add.mockReset().mockImplementation(async (_name, data) => ({ id: "bull", data }))
    mocks.createJob.mockReset().mockImplementation(async (input) => ({ id: "job_new", ...input }))
    mocks.updateJob.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await closeMeetSumQueue()
  })

  it("retries storage.delete five times with exponential backoff", async () => {
    await enqueueMeetSumJob("storage.delete", { workspaceId: "ws_1", keys: ["a"] })

    expect(mocks.createJob).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 5 }))
    expect(mocks.add).toHaveBeenCalledWith(
      "storage.delete",
      expect.objectContaining({ keys: ["a"], workspaceId: "ws_1", jobRecordId: "job_new" }),
      expect.objectContaining({
        jobId: "job_new",
        attempts: 5,
        backoff: { type: "exponential", delay: 3000 },
      })
    )
  })

  it("enqueues media.prepare idempotently per asset with two attempts", async () => {
    await enqueueMeetSumJob("media.prepare", {
      workspaceId: "ws_1",
      meetingId: "m_1",
      assetId: "asset_1",
    })

    expect(mocks.add.mock.calls[0][2]).toMatchObject({
      jobId: "media.prepare-asset_1",
      attempts: 2,
    })
    expect(mediaPrepareJobId("a:b")).toBe("media.prepare-a_b")
    expect(mocks.updateJob).not.toHaveBeenCalled()
  })

  it("closes the new jobs row when BullMQ returns an existing job for the id", async () => {
    mocks.add.mockResolvedValueOnce({ id: "media.prepare-asset_1", data: { jobRecordId: "job_old" } })

    await enqueueMeetSumJob("media.prepare", {
      workspaceId: "ws_1",
      meetingId: "m_1",
      assetId: "asset_1",
    })

    expect(mocks.updateJob).toHaveBeenCalledWith("job_new", {
      status: "completed",
      result: { deduplicated: true, existingJobRecordId: "job_old" },
    })
  })

  it("lets callers override attempts and the job id", async () => {
    await enqueueMeetSumJob(
      "media.prepare",
      { workspaceId: "ws_1", meetingId: "m_1", assetId: "asset_1" },
      { attempts: 1, jobId: "custom" }
    )

    expect(mocks.add.mock.calls[0][2]).toMatchObject({ jobId: "custom", attempts: 1 })
  })
})
