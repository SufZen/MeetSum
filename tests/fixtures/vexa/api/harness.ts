import { vi } from "vitest"

import { getBotConfig } from "@/lib/bot/config"
import type { BotQueuePort, BotJobName, BotJobOptions, BotJobPayloads } from "@/lib/bot/queue"
import { toBullJobId } from "@/lib/bot/queue"

/** Test config: bot on, Vexa set, default limits (override per test). */
export function testBotConfig(env: Record<string, string> = {}) {
  return getBotConfig({
    MEETSUM_BOT_ENABLED: "true",
    VEXA_API_URL: "http://vexa-gateway:8056",
    VEXA_API_KEY: "vexa_test_key_0123456789abcdef",
    MEETSUM_BOT_ACCOUNT_EMAIL: "notetaker@acme.co.il",
    ...env,
  })
}

export type QueuedJob = {
  name: BotJobName
  payload: BotJobPayloads[BotJobName]
  options: BotJobOptions
  id: string
  removed: boolean
  timer?: ReturnType<typeof setTimeout>
}

/**
 * A fake BotQueuePort. Jobs are recorded; with `onFire`, each job runs after
 * its delay through setTimeout (drive it with vi fake timers). BullMQ id
 * semantics: adding an id that exists (and isn't removed) is a no-op.
 */
export function fakeQueue(onFire?: (job: QueuedJob) => Promise<unknown> | unknown) {
  const jobs: QueuedJob[] = []
  const fired: QueuedJob[] = []
  const errors: unknown[] = []

  const find = (id: string) => jobs.find((job) => job.id === toBullJobId(id) && !job.removed)

  const port: BotQueuePort = {
    enqueue: vi.fn(async (name, payload, options = {}) => {
      const id = toBullJobId(options.jobId ?? `${name}-${jobs.length}`)
      const existing = find(id)

      if (existing) return { id: existing.id }

      const job: QueuedJob = { name, payload, options, id, removed: false }

      jobs.push(job)
      if (onFire) {
        job.timer = setTimeout(() => {
          if (job.removed) return
          job.removed = true
          fired.push(job)
          void Promise.resolve()
            .then(() => onFire(job))
            .catch((error: unknown) => errors.push(error))
        }, options.delay ?? 0)
      }
      return { id }
    }) as BotQueuePort["enqueue"],
    remove: vi.fn(async (jobId: string) => {
      const job = find(jobId)

      if (job) {
        job.removed = true
        if (job.timer) clearTimeout(job.timer)
      }
    }),
    getJob: vi.fn(async (jobId: string) => find(jobId)),
  }

  return { port, jobs, fired, errors, pending: () => jobs.filter((job) => !job.removed) }
}
