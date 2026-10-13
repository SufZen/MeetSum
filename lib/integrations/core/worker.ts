/**
 * `meetsum-integrations` queue worker (docs/parity/m8.md, A5). Owner:
 * Package A. Started by worker/index.ts beside the bot worker and closed on
 * shutdown. Concurrency `MEETSUM_INTEGRATIONS_CONCURRENCY` (4), limiter 20
 * jobs/s, custom backoff (`Retry-After`, else exponential from 30 s, ≤ 1 h).
 * Repeatable `integration.tick` (every minute) and `integration.sweep`
 * (daily). Without Postgres (memory/demo) jobs run inline and no worker
 * starts.
 */
import { type Job, UnrecoverableError, Worker } from "bullmq"

import type { IntegrationRuntime } from "@/lib/integrations/core/runtime"
import { RetryableDeliveryError, runIntegrationDelivery } from "@/lib/integrations/core/deliver"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import { integrationLog, storedIntegrationError } from "@/lib/integrations/core/errors"
import { deliveryBackoffMs, deliveryRetentionDays, integrationsConcurrency } from "@/lib/integrations/core/limits"
import {
  deliverJobId,
  INTEGRATION_BACKOFF_TYPE,
  INTEGRATIONS_QUEUE,
  closeIntegrationQueue,
  getIntegrationQueue,
  getIntegrationQueuePort,
  type IntegrationDispatchPayload,
  type IntegrationJobName,
  type IntegrationJobPayloads,
  type IntegrationQueuePort,
} from "@/lib/integrations/core/queue"
import { listProviders } from "@/lib/integrations/core/registry"
import { getIntegrationStore, type IntegrationStore } from "@/lib/integrations/core/store"
import { ProviderError, type IntegrationProvider, type ProviderId } from "@/lib/integrations/core/types"
import { getLogger } from "@/lib/log"
import { runInJobLogContext } from "@/lib/log/job-context"

const log = getLogger({ component: "integrations" })

export type IntegrationWorkerHandle = { close(): Promise<void> }

type AnyJob = Pick<Job, "name" | "data" | "attemptsMade" | "opts">

export type IntegrationJobDeps = {
  store?: IntegrationStore
  queue?: IntegrationQueuePort
  providers?: () => readonly IntegrationProvider[]
  now?: () => Date
  /** Dispatch/deliver runtime overrides (tests). */
  runtime?: Partial<IntegrationRuntime>
}

/** Per-connection provider jobs due now (`<provider>.<job>:<conn>:<bucket>` dedupes per bucket). */
export async function runIntegrationTick(deps: IntegrationJobDeps = {}): Promise<number> {
  const store = deps.store ?? (await getIntegrationStore())
  const queue = deps.queue ?? getIntegrationQueuePort()
  const now = (deps.now ?? (() => new Date()))().getTime()
  let enqueued = 0

  for (const provider of (deps.providers ?? listProviders)()) {
    if (!provider.jobs || provider.id === "email") continue

    const connections = await store.systemListActiveConnections(provider.id as ProviderId)

    for (const [job, spec] of Object.entries(provider.jobs)) {
      const bucket = Math.floor(now / (Math.max(1, spec.everyMinutes) * 60_000))

      for (const connection of connections) {
        await queue.enqueue(
          "integration.job",
          { provider: provider.id, job, workspaceId: connection.workspaceId, connectionId: connection.id },
          { jobId: `${provider.id}.${job}:${connection.id}:${bucket}` }
        )
        enqueued += 1
      }
    }
  }

  // Expired leases (a worker crashed mid-attempt): re-queue with backoff up
  // to max attempts, then fail with a typed reason. Conditional on the lease
  // still being expired, so a live worker is never pre-empted.
  const at = new Date(now)

  for (const row of await store.systemListExpiredDeliveryLeases(at)) {
    if (row.attempts >= row.maxAttempts) {
      await store.reclaimExpiredDelivery(row.workspaceId, row.id, at, {
        status: "failed",
        completedAt: at.toISOString(),
        lastError: storedIntegrationError(new ProviderError("retryable", "lease expired", { providerCode: "lease_expired" }), row.provider),
      })
      continue
    }

    const reclaimed = await store.reclaimExpiredDelivery(row.workspaceId, row.id, at, {
      status: "retrying",
      lastError: storedIntegrationError(new ProviderError("retryable", "lease expired", { providerCode: "lease_expired" }), row.provider),
    })

    if (!reclaimed) continue
    await queue.enqueue(
      "integration.deliver",
      { workspaceId: row.workspaceId, deliveryId: row.id },
      { jobId: deliverJobId(row.id, row.attempts), delay: deliveryBackoffMs(row.attempts) }
    )
    enqueued += 1
  }

  // Deliveries whose enqueue timed out (Redis down) stay `queued`: hand
  // them to the queue again once it is back (same job id: BullMQ dedupes a
  // job that did arrive).
  for (const row of await store.systemListStaleQueuedDeliveries(new Date(now - STALE_QUEUED_MS))) {
    await queue.enqueue("integration.deliver", { workspaceId: row.workspaceId, deliveryId: row.id }, { jobId: deliverJobId(row.id) })
    enqueued += 1
  }

  return enqueued
}

/** A queued delivery untouched this long never reached the queue. */
const STALE_QUEUED_MS = 5 * 60_000

export async function runIntegrationProviderJob(
  payload: IntegrationJobPayloads["integration.job"],
  deps: IntegrationJobDeps = {}
): Promise<unknown> {
  const store = deps.store ?? (await getIntegrationStore())
  const provider = (deps.providers ?? listProviders)().find((candidate) => candidate.id === payload.provider)
  const spec = provider?.jobs?.[payload.job]
  const connection = await store.getConnection(payload.workspaceId, payload.connectionId)

  if (!spec || !connection || connection.status !== "active" || connection.provider !== payload.provider) return undefined

  return spec.run({ workspaceId: payload.workspaceId, connectionId: payload.connectionId })
}

export async function runIntegrationSweep(deps: IntegrationJobDeps = {}): Promise<{ states: number; deliveries: number }> {
  const store = deps.store ?? (await getIntegrationStore())
  const now = (deps.now ?? (() => new Date()))()
  const states = await store.systemDeleteExpiredOAuthStates(now)
  const deliveries = await store.systemDeleteDeliveriesBefore(new Date(now.getTime() - deliveryRetentionDays() * 86_400_000))

  return { states, deliveries }
}

/** Routes one job (exported for tests). */
export async function processIntegrationJob(job: AnyJob, deps: IntegrationJobDeps = {}): Promise<unknown> {
  const name = job.name as IntegrationJobName
  const data = (job.data ?? {}) as Record<string, unknown>

  switch (name) {
    case "integration.dispatch":
      return runIntegrationDispatch(data as IntegrationDispatchPayload, {
        ...deps.runtime,
        ...(deps.store ? { store: deps.store } : {}),
        ...(deps.queue ? { queue: deps.queue } : {}),
      })
    case "integration.deliver": {
      const { workspaceId, deliveryId } = data as IntegrationJobPayloads["integration.deliver"]

      if (typeof workspaceId !== "string" || typeof deliveryId !== "string") throw new UnrecoverableError("deliver without ids")

      const attempts = job.opts?.attempts ?? 1
      const outcome = await runIntegrationDelivery(
        { workspaceId, deliveryId, finalAttempt: job.attemptsMade + 1 >= attempts },
        { ...deps.runtime, ...(deps.store ? { store: deps.store } : {}) }
      )

      if (outcome.status === "retrying") throw new RetryableDeliveryError(outcome.delayMs)
      return outcome
    }
    case "integration.job":
      return runIntegrationProviderJob(data as IntegrationJobPayloads["integration.job"], deps)
    case "integration.tick":
      return runIntegrationTick(deps)
    case "integration.sweep":
      return runIntegrationSweep(deps)
    default:
      throw new UnrecoverableError("unknown integration job")
  }
}

/** BullMQ custom backoff (`backoff: {type: "integration"}`). */
export function integrationBackoffStrategy(attemptsMade: number, _type?: string, error?: Error): number {
  if (error instanceof RetryableDeliveryError) return error.delayMs

  return deliveryBackoffMs(attemptsMade)
}

export async function upsertIntegrationSchedulers(queue = getIntegrationQueue()): Promise<void> {
  await queue.upsertJobScheduler(
    "integration.tick",
    { every: 60_000 },
    { name: "integration.tick", data: {}, opts: { attempts: 1, removeOnComplete: 50, removeOnFail: 100 } }
  )
  await queue.upsertJobScheduler(
    "integration.sweep",
    { every: 24 * 60 * 60_000 },
    { name: "integration.sweep", data: {}, opts: { attempts: 3, removeOnComplete: 20, removeOnFail: 50 } }
  )
}

export function startIntegrationWorker(): IntegrationWorkerHandle | undefined {
  if (process.env.MEETSUM_STORAGE !== "postgres") return undefined

  const worker = new Worker(INTEGRATIONS_QUEUE, (job) => runInJobLogContext(INTEGRATIONS_QUEUE, job, processIntegrationJob), {
    connection: { url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" },
    concurrency: integrationsConcurrency(),
    limiter: { max: 20, duration: 1000 },
    settings: {
      backoffStrategy: (attemptsMade: number, type?: string, error?: Error) =>
        type === INTEGRATION_BACKOFF_TYPE ? integrationBackoffStrategy(attemptsMade, type, error) : 0,
    },
  })

  worker.on("failed", (job, error) => {
    if (error instanceof RetryableDeliveryError) return
    integrationLog.error(`job failed: ${job?.name ?? "unknown"}`, error)
  })
  worker.on("error", (error) => integrationLog.error("worker error", error))

  void upsertIntegrationSchedulers().catch((error: unknown) => integrationLog.error("scheduler setup failed", error))
  log.info("[integrations] meetsum-integrations worker started")

  return {
    async close() {
      await worker.close()
      await closeIntegrationQueue()
    },
  }
}
