import { type Job, type JobsOptions, Queue } from "bullmq"

import { getBotConfig, isBotEnabled } from "@/lib/bot/config"

/**
 * The `meetsum-bot` BullMQ queue (M7 A7). Separate from the `meetsum` queue
 * so a long ASR job never delays a join; bot jobs write no `jobs` rows
 * (bot_sessions is the record). With the bot feature off, enqueue/remove are
 * no-ops so behaviour is unchanged.
 */

export const BOT_QUEUE_NAME = "meetsum-bot"

export const BOT_JOB_NAMES = [
  "bot.dispatch",
  "bot.consent",
  "bot.finalize",
  "bot.reconcile",
  "bot.retention",
] as const
export type BotJobName = (typeof BOT_JOB_NAMES)[number]

export type BotJobPayloads = {
  "bot.dispatch": { sessionId: string; rev: number; workspaceId: string }
  "bot.consent": { sessionId: string; workspaceId: string }
  "bot.finalize": { sessionId: string; workspaceId: string }
  /** `{workspaceId, resyncRules:true}` re-evaluates calendar rules for one workspace. */
  "bot.reconcile": { workspaceId?: string; resyncRules?: boolean }
  "bot.retention": { scheduled?: boolean }
}

export type BotJobOptions = {
  /** e.g. `bot.dispatch:<sessionId>:<rev>`, `bot.finalize:<sessionId>`. */
  jobId?: string
  delay?: number
  attempts?: number
}

/** Jobs that act on one session must carry its workspace. */
const WORKSPACE_SCOPED: readonly BotJobName[] = ["bot.dispatch", "bot.consent", "bot.finalize"]

export class BotJobWorkspaceRequiredError extends Error {
  constructor(name: BotJobName) {
    super(`${name} job requires a workspaceId`)
    this.name = "BotJobWorkspaceRequiredError"
  }
}

/**
 * BullMQ rejects custom ids containing `:` (unless exactly three parts), so
 * the spec's `bot.finalize:<id>` form is stored as `bot.finalize-<id>`.
 */
export function toBullJobId(jobId: string): string {
  return jobId.replace(/:/g, "-")
}

export function dispatchJobId(sessionId: string, rev: number) {
  return `bot.dispatch:${sessionId}:${rev}`
}

export function finalizeJobId(sessionId: string) {
  return `bot.finalize:${sessionId}`
}

export function consentJobId(sessionId: string) {
  return `bot.consent:${sessionId}`
}

/** Retry policy per job name (A6/A7/A8). */
export function defaultBotJobOptions(
  name: BotJobName,
  config = getBotConfig()
): Pick<JobsOptions, "attempts" | "backoff"> {
  switch (name) {
    case "bot.dispatch":
      return { attempts: 5, backoff: { type: "fixed", delay: 15_000 } }
    case "bot.finalize":
      return { attempts: config.finalizeAttempts, backoff: { type: "exponential", delay: 30_000 } }
    case "bot.consent":
      return { attempts: 1 }
    case "bot.reconcile":
      return { attempts: 1 }
    case "bot.retention":
      return { attempts: 3, backoff: { type: "exponential", delay: 60_000 } }
  }
}

type BotQueue = Queue<BotJobPayloads[BotJobName], unknown, BotJobName>

let queue: BotQueue | undefined

export function getBotQueue(): BotQueue {
  queue ??= new Queue<BotJobPayloads[BotJobName], unknown, BotJobName>(BOT_QUEUE_NAME, {
    connection: { url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" },
  })

  return queue
}

export async function enqueueBotJob<Name extends BotJobName>(
  name: Name,
  payload: BotJobPayloads[Name],
  options: BotJobOptions = {}
): Promise<{ id?: string } | undefined> {
  if (!isBotEnabled()) return undefined

  const scoped = payload as { workspaceId?: unknown }

  if (
    WORKSPACE_SCOPED.includes(name) &&
    (typeof scoped.workspaceId !== "string" || !scoped.workspaceId.trim())
  ) {
    throw new BotJobWorkspaceRequiredError(name)
  }

  const defaults = defaultBotJobOptions(name)
  const job = await getBotQueue().add(name, payload, {
    ...defaults,
    ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
    ...(options.jobId ? { jobId: toBullJobId(options.jobId) } : {}),
    ...(options.delay !== undefined ? { delay: Math.max(0, Math.round(options.delay)) } : {}),
    removeOnComplete: 500,
    removeOnFail: 1000,
  })

  return { id: job.id }
}

export async function removeBotJob(jobId: string): Promise<void> {
  if (!isBotEnabled()) return

  const job = await getBotQueue().getJob(toBullJobId(jobId))

  // A job that is already running holds a lock; its rev check makes it a no-op.
  await job?.remove().catch(() => undefined)
}

export async function getBotJob(jobId: string): Promise<Job | undefined> {
  if (!isBotEnabled()) return undefined

  return (await getBotQueue().getJob(toBullJobId(jobId))) ?? undefined
}

export async function closeBotQueue() {
  if (queue) {
    await queue.close()
    queue = undefined
  }
}

/** What the dispatcher, calendar sync and reconcile need from the queue (injectable). */
export type BotQueuePort = {
  enqueue: typeof enqueueBotJob
  remove: typeof removeBotJob
  getJob: (jobId: string) => Promise<unknown>
}

export const defaultBotQueuePort: BotQueuePort = {
  enqueue: enqueueBotJob,
  remove: removeBotJob,
  getJob: getBotJob,
}
