/**
 * Worker jobs run inside `withLogContext({ jobId, queue, jobName, workspaceId? })`
 * (docs/parity/m10.md, "Request ids"), so every line a job logs, at any
 * depth, carries the job's identity.
 */
import { withLogContext, type LogContext } from "@/lib/log"

type JobLike = { id?: string | null; name: string; data?: unknown }

export function jobLogContext(queue: string, job: JobLike): LogContext {
  const data = job.data as { workspaceId?: unknown } | undefined
  const workspaceId = typeof data?.workspaceId === "string" ? data.workspaceId : undefined

  return {
    jobId: job.id ? String(job.id) : undefined,
    queue,
    jobName: job.name,
    ...(workspaceId ? { workspaceId } : {}),
  }
}

/** Runs a BullMQ processor in the job's log context. */
export function runInJobLogContext<J extends JobLike, T>(queue: string, job: J, fn: (job: J) => T): T {
  return withLogContext(jobLogContext(queue, job), () => fn(job))
}
