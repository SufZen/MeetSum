import { Queue } from "bullmq"

import { getCaptureWorkspaceId } from "@/lib/capture/workspace"
import {
  getSystemMeetingRepository,
  resolveMeetingWorkspaceId,
} from "@/lib/meetings/store"

export type MeetSumJobName =
  | "media.ingest"
  | "artifact.import"
  | "meeting.transcribe"
  | "meeting.summarize"
  | "meeting.index"
  | "google.calendar.poll"
  | "google.drive.poll"
  | "google.gmail.poll"
  | "google.meet.poll"
  | "webhook.deliver"
  | "realizeos.export"
  | "teams.subscription.renew"
  | "media.retention"

export type MeetSumJobPayload = {
  meetingId?: string
  /** Owning workspace; persisted on the jobs row and resolved by the worker. */
  workspaceId?: string
  [key: string]: unknown
}

/** A job that cannot be attributed to a workspace is never enqueued. */
export class JobWorkspaceRequiredError extends Error {
  constructor(name: MeetSumJobName) {
    super(`${name} job requires a workspaceId`)
    this.name = "JobWorkspaceRequiredError"
  }
}

let queue: Queue<MeetSumJobPayload, unknown, MeetSumJobName> | undefined

export function getMeetSumQueue() {
  queue ??= new Queue<MeetSumJobPayload, unknown, MeetSumJobName>("meetsum", {
    connection: {
      url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    },
  })

  return queue
}

export function getJobAttempts(
  env: Record<string, string | undefined> = process.env
) {
  const parsed = Number(env.MEETSUM_JOB_ATTEMPTS)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3
}

/**
 * Workspace of a job about to be enqueued: the explicit payload value, else
 * the meeting's workspace, else (Teams subscription renewal only, which is
 * instance-level) the capture workspace.
 */
export async function resolveEnqueueWorkspaceId(
  name: MeetSumJobName,
  payload: MeetSumJobPayload
): Promise<string | undefined> {
  if (typeof payload.workspaceId === "string" && payload.workspaceId.trim()) {
    return payload.workspaceId.trim()
  }

  if (payload.meetingId) {
    const workspaceId = await resolveMeetingWorkspaceId(payload.meetingId)

    if (workspaceId) return workspaceId
  }

  if (name === "teams.subscription.renew") return getCaptureWorkspaceId()

  return undefined
}

/**
 * Guarantees jobs.workspace_id is set even if the repository's createJob does
 * not stamp it (the column has no default and is how job lists are scoped).
 */
async function persistJobWorkspace(jobId: string, workspaceId: string) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return

  const { getDatabasePool } = await import("@/lib/db/client")

  await getDatabasePool().query(
    `update jobs set workspace_id = $2 where id = $1 and workspace_id is null`,
    [jobId, workspaceId]
  )
}

/**
 * Records the job in the workspace's jobs table and adds it to BullMQ. The
 * payload always carries `workspaceId` so the worker can scope its work.
 * (`webhook.deliver` jobs bypass this: see lib/webhooks/delivery.ts.)
 */
export async function enqueueMeetSumJob(
  name: MeetSumJobName,
  payload: MeetSumJobPayload = {}
) {
  const workspaceId = await resolveEnqueueWorkspaceId(name, payload)

  if (!workspaceId) throw new JobWorkspaceRequiredError(name)

  const attempts = getJobAttempts()
  const scopedPayload = { ...payload, workspaceId }
  const record = await getSystemMeetingRepository(workspaceId).createJob({
    name,
    meetingId: payload.meetingId,
    payload: scopedPayload,
    retryOfJobId:
      typeof payload.retryOfJobId === "string" ? payload.retryOfJobId : undefined,
    maxAttempts: attempts,
  })

  await persistJobWorkspace(record.id, workspaceId)

  await getMeetSumQueue().add(name, { ...scopedPayload, jobRecordId: record.id }, {
    jobId: record.id,
    attempts,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: 250,
    removeOnFail: 500,
  })

  return record
}

export async function closeMeetSumQueue() {
  if (queue) {
    await queue.close()
    queue = undefined
  }
}
