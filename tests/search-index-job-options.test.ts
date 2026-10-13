import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A BullMQ stand-in with the semantics that matter here: an add with an id
 * that is still stored (waiting, delayed, active, or a retained finished
 * job) returns the existing job instead of creating one.
 */
const bull = vi.hoisted(() => {
  type Stored = { id: string; data: Record<string, unknown>; opts: Record<string, unknown>; state: "delayed" | "done" }
  const jobs = new Map<string, Stored>()
  const add = vi.fn(async (_name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
    const id = String(opts.jobId)
    const existing = jobs.get(id)

    if (existing) return existing
    const job: Stored = { id, data, opts, state: "delayed" }

    jobs.set(id, job)
    return job
  })
  /** The worker finishes the job; BullMQ drops it when removeOnComplete is true. */
  const complete = (id: string) => {
    const job = jobs.get(id)

    if (!job) return
    if (job.opts.removeOnComplete === true) jobs.delete(id)
    else job.state = "done"
  }

  return { jobs, add, complete }
})

vi.mock("bullmq", () => ({
  Queue: vi.fn(function Queue() {
    return { add: bull.add, close: vi.fn() }
  }),
}))

const repo = vi.hoisted(() => {
  let counter = 0

  return {
    createJob: vi.fn(async (input: Record<string, unknown>) => ({ id: `job_${(counter += 1)}`, ...input })),
    updateJob: vi.fn(async () => ({})),
  }
})

vi.mock("@/lib/meetings/store", () => ({
  getSystemMeetingRepository: () => repo,
  resolveMeetingWorkspaceId: vi.fn(async () => "ws_1"),
}))

const { closeMeetSumQueue, defaultJobOptions, enqueueMeetSumJob, searchIndexSweepJobId } = await import(
  "@/lib/jobs/queue"
)
const { enqueueMeetingIndexJob, meetingIndexJobId, requestMeetingReindex } = await import("@/lib/search/index-trigger")

beforeEach(() => {
  bull.jobs.clear()
  bull.add.mockClear()
  repo.updateJob.mockClear()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMeetSumQueue()
})

describe("meeting.index job retention (M6)", () => {
  it("removes finished index and sweep jobs from Redis", () => {
    expect(defaultJobOptions("meeting.index", { meetingId: "m1", workspaceId: "ws_1" })).toEqual({
      removeOnComplete: true,
      removeOnFail: true,
    })
    expect(defaultJobOptions("search.index.sweep", { workspaceId: "ws_1" })).toEqual({
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
      jobId: "search.index.sweep-ws_1",
    })
    expect(searchIndexSweepJobId("a:b")).toBe("search.index.sweep-a_b")
  })

  it("passes the retention options to BullMQ and keeps the default for other jobs", async () => {
    await enqueueMeetingIndexJob({ workspaceId: "ws_1", meetingId: "m1", reason: "renamed" }, { delay: 15_000 })
    await enqueueMeetSumJob("meeting.summarize", { meetingId: "m1", workspaceId: "ws_1" })

    expect(bull.add.mock.calls[0][2]).toMatchObject({
      jobId: "meeting.index-m1",
      delay: 15_000,
      removeOnComplete: true,
      removeOnFail: true,
    })
    expect(bull.add.mock.calls[1][2]).toMatchObject({ removeOnComplete: 250, removeOnFail: 500 })
  })

  it("debounces edits while a run is pending, and a later edit enqueues a new run after completion", async () => {
    vi.stubEnv("MEETSUM_INDEX_DEBOUNCE_MS", "15000")
    const db = { query: vi.fn(async () => ({ rows: [] })) }

    await requestMeetingReindex({ workspaceId: "ws_1", meetingId: "m1", reason: "renamed", db })
    await requestMeetingReindex({ workspaceId: "ws_1", meetingId: "m1", reason: "tags", db })

    expect(bull.jobs.size).toBe(1)
    // The deduplicated add closes its jobs row instead of leaving it queued.
    expect(repo.updateJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "completed", result: expect.objectContaining({ deduplicated: true }) })
    )
    const firstRecord = bull.jobs.get(meetingIndexJobId("m1"))?.data.jobRecordId

    bull.complete(meetingIndexJobId("m1"))
    await requestMeetingReindex({ workspaceId: "ws_1", meetingId: "m1", reason: "transcript.edited", db })

    const next = bull.jobs.get(meetingIndexJobId("m1"))

    expect(next).toBeDefined()
    expect(next?.data.jobRecordId).not.toBe(firstRecord)
    expect(next?.data.reason).toBe("transcript.edited")
  })
})
