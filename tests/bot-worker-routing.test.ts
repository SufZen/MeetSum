import { UnrecoverableError } from "bullmq"
import { afterEach, describe, expect, it, vi } from "vitest"

import { getBotConfig } from "@/lib/bot/config"
import { BOT_JOB_NAMES, defaultBotJobOptions, enqueueBotJob, toBullJobId } from "@/lib/bot/queue"
import {
  BOT_RECONCILE_SCHEDULER_ID,
  BOT_RETENTION_SCHEDULER_ID,
  type BotJobHandlers,
  processBotJob,
  startBotWorker,
  upsertBotSchedulers,
} from "@/lib/bot/worker"

function handlers() {
  return {
    "bot.dispatch": vi.fn(async () => "dispatched"),
    "bot.consent": vi.fn(async () => "consent"),
    "bot.finalize": vi.fn(async () => "finalized"),
    "bot.reconcile": vi.fn(async () => "reconciled"),
    "bot.retention": vi.fn(async () => "retained"),
  } satisfies BotJobHandlers
}

function job(name: string, data: Record<string, unknown>, extra: { attemptsMade?: number; attempts?: number } = {}) {
  return { id: "1", name, data, attemptsMade: extra.attemptsMade ?? 0, opts: { attempts: extra.attempts ?? 1 } }
}

const exists = vi.fn(async (workspaceId: string) => workspaceId !== "ws_deleted")

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("processBotJob", () => {
  it.each([
    ["bot.dispatch", { sessionId: "bot_1", rev: 2, workspaceId: "ws_a" }, "dispatched"],
    ["bot.consent", { sessionId: "bot_1", workspaceId: "ws_a" }, "consent"],
    ["bot.reconcile", {}, "reconciled"],
    ["bot.reconcile", { workspaceId: "ws_a", resyncRules: true }, "reconciled"],
    ["bot.retention", { scheduled: true }, "retained"],
  ] as const)("routes %s", async (name, data, expected) => {
    const routes = handlers()

    expect(await processBotJob(job(name, data), { handlers: routes, workspaceExists: exists })).toBe(expected)
    expect(routes[name]).toHaveBeenCalledWith(data)
    for (const other of BOT_JOB_NAMES.filter((item) => item !== name)) {
      expect(routes[other]).not.toHaveBeenCalled()
    }
  })

  it("passes finalAttempt to finalize on the last BullMQ attempt", async () => {
    const routes = handlers()
    const data = { sessionId: "bot_1", workspaceId: "ws_a" }

    await processBotJob(job("bot.finalize", data, { attemptsMade: 3, attempts: 8 }), { handlers: routes, workspaceExists: exists })
    await processBotJob(job("bot.finalize", data, { attemptsMade: 7, attempts: 8 }), { handlers: routes, workspaceExists: exists })

    expect(routes["bot.finalize"].mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      { ...data, finalAttempt: false },
      { ...data, finalAttempt: true },
    ])
  })

  it("a deleted workspace is unrecoverable", async () => {
    const routes = handlers()

    await expect(
      processBotJob(job("bot.dispatch", { sessionId: "bot_1", rev: 0, workspaceId: "ws_deleted" }), {
        handlers: routes,
        workspaceExists: exists,
      })
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(routes["bot.dispatch"]).not.toHaveBeenCalled()
  })

  it("session jobs without a workspace and unknown jobs are unrecoverable", async () => {
    const routes = handlers()

    await expect(processBotJob(job("bot.consent", { sessionId: "bot_1" }), { handlers: routes, workspaceExists: exists })).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    await expect(processBotJob(job("bot.unknown", {}), { handlers: routes, workspaceExists: exists })).rejects.toBeInstanceOf(
      UnrecoverableError
    )
  })
})

describe("schedulers and queue", () => {
  it("upserts reconcile and daily retention schedulers", async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) }

    await upsertBotSchedulers(queue as never, getBotConfig({ MEETSUM_BOT_RECONCILE_SECONDS: "90" }))

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      BOT_RECONCILE_SCHEDULER_ID,
      { every: 90_000 },
      expect.objectContaining({ name: "bot.reconcile" })
    )
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      BOT_RETENTION_SCHEDULER_ID,
      { every: 86_400_000 },
      expect.objectContaining({ name: "bot.retention" })
    )
  })

  it("does not start (or enqueue) when the bot is disabled", async () => {
    vi.stubEnv("MEETSUM_BOT_ENABLED", "false")

    expect(startBotWorker()).toBeUndefined()
    expect(await enqueueBotJob("bot.reconcile", {})).toBeUndefined()
  })

  it("requires workspaceId on session jobs", async () => {
    vi.stubEnv("MEETSUM_BOT_ENABLED", "true")

    await expect(enqueueBotJob("bot.finalize", { sessionId: "bot_1" } as never)).rejects.toThrow("requires a workspaceId")
  })

  it("job ids and retry policy", () => {
    expect(toBullJobId("bot.finalize:bot_1")).toBe("bot.finalize-bot_1")
    expect(defaultBotJobOptions("bot.dispatch")).toEqual({ attempts: 5, backoff: { type: "fixed", delay: 15_000 } })
    expect(defaultBotJobOptions("bot.finalize", getBotConfig({ MEETSUM_BOT_FINALIZE_ATTEMPTS: "8" }))).toEqual({
      attempts: 8,
      backoff: { type: "exponential", delay: 30_000 },
    })
  })
})
