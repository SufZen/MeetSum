import { type Job, UnrecoverableError, Worker } from "bullmq"

import { type BotConfig, getBotConfig, isBotEnabled } from "@/lib/bot/config"
import { runBotConsent } from "@/lib/bot/consent"
import { runDispatch } from "@/lib/bot/dispatch"
import { finalizeBotSession } from "@/lib/bot/finalize"
import { BOT_QUEUE_NAME, type BotJobName, type BotJobPayloads, closeBotQueue, getBotQueue } from "@/lib/bot/queue"
import { runBotReconcile } from "@/lib/bot/reconcile"
import { botLog, redactBotError } from "@/lib/bot/redact"
import { runBotRetention } from "@/lib/bot/retention"
import { getLogger } from "@/lib/log"
import { runInJobLogContext } from "@/lib/log/job-context"

const log = getLogger({ component: "bot" })

/**
 * The bot BullMQ worker (M7 A7), started from worker/index.ts next to the
 * main worker. Returns undefined when the bot feature is disabled.
 */

export type BotWorkerHandle = { close(): Promise<void>; isRunning(): boolean }

export type BotJobHandlers = {
  "bot.dispatch": (payload: BotJobPayloads["bot.dispatch"]) => Promise<unknown>
  "bot.consent": (payload: BotJobPayloads["bot.consent"]) => Promise<unknown>
  "bot.finalize": (payload: BotJobPayloads["bot.finalize"] & { finalAttempt: boolean }) => Promise<unknown>
  "bot.reconcile": (payload: BotJobPayloads["bot.reconcile"]) => Promise<unknown>
  "bot.retention": (payload: BotJobPayloads["bot.retention"]) => Promise<unknown>
}

export type BotJobContext = {
  handlers: BotJobHandlers
  /** False when the workspace is gone (deleted or soft-deleted). */
  workspaceExists: (workspaceId: string) => Promise<boolean>
}

async function defaultWorkspaceExists(workspaceId: string): Promise<boolean> {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")

  return Boolean(await getWorkspaceStore().getWorkspace(workspaceId))
}

export const defaultBotJobHandlers: BotJobHandlers = {
  "bot.dispatch": (payload) => runDispatch(payload),
  "bot.consent": (payload) => runBotConsent(payload),
  "bot.finalize": ({ sessionId, workspaceId, finalAttempt }) =>
    finalizeBotSession({ sessionId, workspaceId, finalAttempt }),
  "bot.reconcile": (payload) => runBotReconcile(payload),
  "bot.retention": () => runBotRetention(),
}

type AnyBotJob = Pick<Job, "name" | "data" | "attemptsMade" | "opts" | "id">

/** Routes one job to its handler (exported for tests). */
export async function processBotJob(job: AnyBotJob, context: Partial<BotJobContext> = {}): Promise<unknown> {
  const handlers = context.handlers ?? defaultBotJobHandlers
  const workspaceExists = context.workspaceExists ?? defaultWorkspaceExists
  const name = job.name as BotJobName
  const data = (job.data ?? {}) as Record<string, unknown>
  const workspaceId = typeof data.workspaceId === "string" ? data.workspaceId : undefined

  if ((name === "bot.dispatch" || name === "bot.consent" || name === "bot.finalize") && !workspaceId) {
    throw new UnrecoverableError(`${name} job without workspaceId`)
  }
  if (workspaceId && !(await workspaceExists(workspaceId))) {
    throw new UnrecoverableError(`${name}: workspace no longer exists`)
  }

  switch (name) {
    case "bot.dispatch":
      return handlers["bot.dispatch"](data as BotJobPayloads["bot.dispatch"])
    case "bot.consent":
      return handlers["bot.consent"](data as BotJobPayloads["bot.consent"])
    case "bot.finalize": {
      const attempts = job.opts?.attempts ?? 1

      return handlers["bot.finalize"]({
        ...(data as BotJobPayloads["bot.finalize"]),
        finalAttempt: job.attemptsMade + 1 >= attempts,
      })
    }
    case "bot.reconcile":
      return handlers["bot.reconcile"](data as BotJobPayloads["bot.reconcile"])
    case "bot.retention":
      return handlers["bot.retention"](data as BotJobPayloads["bot.retention"])
    default:
      throw new UnrecoverableError("unknown bot job")
  }
}

export const BOT_RECONCILE_SCHEDULER_ID = "bot.reconcile"
export const BOT_RETENTION_SCHEDULER_ID = "bot.retention"

/** BullMQ job schedulers, idempotent across worker processes (upsert by id). */
export async function upsertBotSchedulers(
  queue: Pick<ReturnType<typeof getBotQueue>, "upsertJobScheduler"> = getBotQueue(),
  config: BotConfig = getBotConfig()
): Promise<void> {
  await queue.upsertJobScheduler(
    BOT_RECONCILE_SCHEDULER_ID,
    { every: config.reconcileSeconds * 1000 },
    { name: "bot.reconcile", data: {}, opts: { attempts: 1, removeOnComplete: 50, removeOnFail: 100 } }
  )
  await queue.upsertJobScheduler(
    BOT_RETENTION_SCHEDULER_ID,
    { every: 24 * 60 * 60 * 1000 },
    { name: "bot.retention", data: { scheduled: true }, opts: { attempts: 3, removeOnComplete: 20, removeOnFail: 50 } }
  )
}

export function startBotWorker(): BotWorkerHandle | undefined {
  if (!isBotEnabled()) return undefined

  const config = getBotConfig()
  const worker = new Worker(BOT_QUEUE_NAME, (job) => runInJobLogContext(BOT_QUEUE_NAME, job, processBotJob), {
    connection: { url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" },
    concurrency: config.workerConcurrency,
    // Finalize streams a whole recording into storage.
    lockDuration: 30 * 60_000,
  })

  worker.on("failed", (job, error) => {
    botLog.error(`job failed: ${job?.name ?? "unknown"} ${job?.id ?? ""}`, error)
  })
  worker.on("error", (error) => {
    botLog.error("worker error", error)
  })

  void upsertBotSchedulers(getBotQueue(), config).catch((error: unknown) => {
    log.error(`[bot] scheduler setup failed: ${redactBotError(error)}`)
  })
  log.info("[bot] meetsum-bot worker started")

  return {
    isRunning: () => worker.isRunning(),
    async close() {
      await worker.close()
      await closeBotQueue()
    },
  }
}
