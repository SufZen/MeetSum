/**
 * M8 integrations queue (docs/parity/m8.md, A4/A5). A separate BullMQ queue
 * (as M7 does with `meetsum-bot`) so a long ASR job never delays a delivery.
 * No `jobs` rows are written; `integration_deliveries` is the record.
 * Owned by Package A.
 *
 * Payloads carry ids only (never tokens or content). Without Postgres (the
 * memory/demo backend) jobs run inline, once.
 */
import { type JobsOptions, Queue } from "bullmq"

import { integrationMaxAttempts } from "@/lib/integrations/core/limits"

export const INTEGRATIONS_QUEUE = "meetsum-integrations"

export const INTEGRATION_JOB_NAMES = [
  /** jobId `integration.dispatch:<eventId>`: rules → delivery rows. */
  "integration.dispatch",
  /** jobId `<deliveryId>`: one provider push. */
  "integration.deliver",
  /** Provider `jobs` (e.g. Outlook calendarSync) per connection. */
  "integration.job",
  /** Repeatable, every minute: enqueues due per-connection jobs. */
  "integration.tick",
  /** Daily: expired OAuth states, old deliveries. */
  "integration.sweep",
] as const

export type IntegrationJobName = (typeof INTEGRATION_JOB_NAMES)[number]

export type IntegrationDispatchPayload = {
  workspaceId: string
  eventName: string
  eventId: string
  meetingId: string
  actionItemId?: string
}

export type IntegrationJobPayloads = {
  "integration.dispatch": IntegrationDispatchPayload
  "integration.deliver": { workspaceId: string; deliveryId: string }
  "integration.job": { provider: string; job: string; workspaceId: string; connectionId: string }
  "integration.tick": Record<string, never>
  "integration.sweep": Record<string, never>
}

/** Custom backoff type resolved by the worker (`Retry-After`, else exponential). */
export const INTEGRATION_BACKOFF_TYPE = "integration"

/** BullMQ rejects most custom ids containing `:`. */
export function toBullJobId(jobId: string): string {
  return jobId.replace(/:/g, "-")
}

type IntegrationQueue = Queue<IntegrationJobPayloads[IntegrationJobName], unknown, IntegrationJobName>

let queue: IntegrationQueue | undefined

export function getIntegrationQueue(): IntegrationQueue {
  queue ??= new Queue<IntegrationJobPayloads[IntegrationJobName], unknown, IntegrationJobName>(INTEGRATIONS_QUEUE, {
    connection: { url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" },
  })
  // A Redis outage must never become an unhandled 'error' event.
  queue.on("error", () => undefined)

  return queue
}

export async function closeIntegrationQueue() {
  if (queue) {
    await queue.close()
    queue = undefined
  }
}

function defaultOptions(name: IntegrationJobName): Pick<JobsOptions, "attempts" | "backoff"> {
  switch (name) {
    case "integration.deliver":
      return { attempts: integrationMaxAttempts(), backoff: { type: INTEGRATION_BACKOFF_TYPE } }
    case "integration.dispatch":
      return { attempts: 3, backoff: { type: "exponential", delay: 10_000 } }
    case "integration.job":
      return { attempts: 2, backoff: { type: "exponential", delay: 60_000 } }
    default:
      return { attempts: 1 }
  }
}

/** How dispatch, manual sends and retries reach the worker (injectable). */
export type IntegrationQueuePort = {
  enqueue<Name extends IntegrationJobName>(
    name: Name,
    payload: IntegrationJobPayloads[Name],
    options?: { jobId?: string; delay?: number }
  ): Promise<void>
}

export const bullIntegrationQueuePort: IntegrationQueuePort = {
  async enqueue(name, payload, options = {}) {
    await getIntegrationQueue().add(name, payload, {
      ...defaultOptions(name),
      ...(options.jobId ? { jobId: toBullJobId(options.jobId) } : {}),
      ...(options.delay !== undefined ? { delay: Math.max(0, Math.round(options.delay)) } : {}),
      removeOnComplete: 500,
      removeOnFail: 1000,
    })
  },
}

/** Memory/demo backend: run the job now, once (no retries). */
export const inlineIntegrationQueuePort: IntegrationQueuePort = {
  async enqueue(name, payload) {
    if (name === "integration.dispatch") {
      const { runIntegrationDispatch } = await import("@/lib/integrations/core/dispatcher")

      await runIntegrationDispatch(payload as IntegrationDispatchPayload)
    } else if (name === "integration.deliver") {
      const { runIntegrationDelivery } = await import("@/lib/integrations/core/deliver")

      await runIntegrationDelivery({ ...(payload as IntegrationJobPayloads["integration.deliver"]), finalAttempt: true })
    }
  },
}

let portOverride: IntegrationQueuePort | undefined

export function getIntegrationQueuePort(): IntegrationQueuePort {
  if (portOverride) return portOverride

  return process.env.MEETSUM_STORAGE === "postgres" ? bullIntegrationQueuePort : inlineIntegrationQueuePort
}

/** Tests: replace the queue port (undefined restores the default). */
export function setIntegrationQueuePortForTesting(port: IntegrationQueuePort | undefined) {
  portOverride = port
}

export function deliverJobId(deliveryId: string, retry?: number): string {
  return retry ? `integration.deliver:${deliveryId}:r${retry}` : deliveryId
}

export function dispatchJobId(eventId: string): string {
  return `integration.dispatch:${eventId}`
}
