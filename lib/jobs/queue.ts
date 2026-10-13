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
  | "media.prepare"
  | "storage.delete"
  | "meeting.analyze"
  | "clip.render"
  /** M6: re-index stale/failed meetings (owner: Package A). */
  | "search.index.sweep"

export type MeetSumJobPayload = {
  meetingId?: string
  /** Owning workspace; persisted on the jobs row and resolved by the worker. */
  workspaceId?: string
  [key: string]: unknown
}

/**
 * Jobs that may be enqueued without an explicit workspace: Teams subscription
 * renewal is instance-level (resolved to the capture workspace) and
 * `webhook.deliver` carries its workspace inside the delivery row.
 */
export type WorkspaceOptionalJobName = "teams.subscription.renew" | "webhook.deliver"

export type WorkspaceScopedJobName = Exclude<MeetSumJobName, WorkspaceOptionalJobName>

/** Payload of a workspace-scoped job: `workspaceId` is mandatory. */
export type WorkspaceScopedJobPayload = MeetSumJobPayload & { workspaceId: string }

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

/** Per-enqueue overrides (M4). */
export type EnqueueJobOptions = {
  /**
   * BullMQ job id for idempotent enqueues (no `:`; BullMQ rejects it). A
   * duplicate add returns the existing job and the new jobs row is closed.
   */
  jobId?: string
  attempts?: number
  /** Milliseconds before the job becomes runnable (M6 re-index debounce). */
  delay?: number
  /** BullMQ retention of finished jobs (default: keep the last 250 / 500). */
  removeOnComplete?: boolean | number
  removeOnFail?: boolean | number
}

/** `media.prepare-<assetId>` (spec `media.prepare:<id>`; BullMQ forbids `:`). */
export function mediaPrepareJobId(assetId: string) {
  return `media.prepare-${assetId.replace(/:/g, "_")}`
}

/** `search.index.sweep-<workspaceId>`: at most one pending sweep per workspace (M6). */
export function searchIndexSweepJobId(workspaceId: string) {
  return `search.index.sweep-${workspaceId.replace(/:/g, "_")}`
}

/**
 * Defaults per job name (M4): `media.prepare` is idempotent per asset and
 * tried twice; `storage.delete` retries five times with exponential backoff.
 *
 * M6: `meeting.index` (one id per meeting, debounced) and
 * `search.index.sweep` (one id per workspace) are removed from Redis once
 * finished. A retained finished job keeps its id, so it would swallow every
 * later add with the same id and the meeting would never be re-indexed.
 */
export function defaultJobOptions(
  name: MeetSumJobName,
  payload: MeetSumJobPayload
): EnqueueJobOptions {
  if (name === "media.prepare") {
    return {
      attempts: 2,
      ...(typeof payload.assetId === "string" && payload.assetId
        ? { jobId: mediaPrepareJobId(payload.assetId) }
        : {}),
    }
  }
  if (name === "storage.delete") return { attempts: 5 }
  if (name === "meeting.index") return { removeOnComplete: true, removeOnFail: true }
  if (name === "search.index.sweep") {
    return {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
      ...(typeof payload.workspaceId === "string" && payload.workspaceId
        ? { jobId: searchIndexSweepJobId(payload.workspaceId) }
        : {}),
    }
  }

  return {}
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
  name: WorkspaceScopedJobName,
  payload: WorkspaceScopedJobPayload,
  options?: EnqueueJobOptions
): Promise<Awaited<ReturnType<typeof enqueueJob>>>
export async function enqueueMeetSumJob(
  name: WorkspaceOptionalJobName,
  payload?: MeetSumJobPayload,
  options?: EnqueueJobOptions
): Promise<Awaited<ReturnType<typeof enqueueJob>>>
/** Dynamic job name (e.g. a retry): the workspace must be explicit. */
export async function enqueueMeetSumJob(
  name: MeetSumJobName,
  payload: WorkspaceScopedJobPayload,
  options?: EnqueueJobOptions
): Promise<Awaited<ReturnType<typeof enqueueJob>>>
export async function enqueueMeetSumJob(
  name: MeetSumJobName,
  payload: MeetSumJobPayload = {},
  options: EnqueueJobOptions = {}
) {
  return enqueueJob(name, payload, options)
}

/** The queue (Redis) did not accept the job in time (routes → 503 `queue_unavailable`). */
export class QueueUnavailableError extends Error {
  constructor(readonly jobName: string) {
    super("queue_unavailable")
    this.name = "QueueUnavailableError"
  }
}

const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000

export function getEnqueueTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.MEETSUM_QUEUE_ENQUEUE_TIMEOUT_MS)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ENQUEUE_TIMEOUT_MS
}

/** BullMQ's add() never rejects while Redis is unreachable: bound it. */
function withEnqueueTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new QueueUnavailableError("enqueue_timeout")), getEnqueueTimeoutMs())
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function enqueueJob(
  name: MeetSumJobName,
  payload: MeetSumJobPayload,
  options: EnqueueJobOptions = {}
) {
  const workspaceId = await resolveEnqueueWorkspaceId(name, payload)

  if (!workspaceId) throw new JobWorkspaceRequiredError(name)

  const { jobId, attempts: attemptsOverride, delay, removeOnComplete, removeOnFail } = {
    ...defaultJobOptions(name, payload),
    ...options,
  }
  const attempts =
    attemptsOverride !== undefined && Number.isInteger(attemptsOverride) && attemptsOverride > 0
      ? attemptsOverride
      : getJobAttempts()
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

  let added: unknown

  try {
    added = await withEnqueueTimeout(
      getMeetSumQueue().add(name, { ...scopedPayload, jobRecordId: record.id }, {
        jobId: jobId ?? record.id,
        attempts,
        ...(delay !== undefined && Number.isFinite(delay) && delay > 0 ? { delay } : {}),
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: removeOnComplete ?? 250,
        removeOnFail: removeOnFail ?? 500,
      })
    )
  } catch (error) {
    // Redis unreachable or slow: the job never reached the queue, so its
    // record must not stay "queued" forever.
    await getSystemMeetingRepository(workspaceId)
      .updateJob(record.id, { status: "failed", error: "queue_unavailable" })
      .catch(() => undefined)
    throw error instanceof QueueUnavailableError ? error : new QueueUnavailableError(name)
  }

  // An idempotent id that already exists returns the existing BullMQ job:
  // close the jobs row created for this ignored add.
  const existingRecordId = (added as { data?: { jobRecordId?: unknown } } | undefined)?.data
    ?.jobRecordId

  if (jobId && typeof existingRecordId === "string" && existingRecordId !== record.id) {
    await getSystemMeetingRepository(workspaceId)
      .updateJob(record.id, {
        status: "completed",
        result: { deduplicated: true, existingJobRecordId: existingRecordId },
      })
      .catch(() => undefined)
  }

  return record
}

export async function closeMeetSumQueue() {
  if (queue) {
    await queue.close()
    queue = undefined
  }
}
