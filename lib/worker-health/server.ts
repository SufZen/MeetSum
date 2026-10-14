/**
 * Worker health server (docs/parity/m10.md, "Worker health"): plain HTTP on
 * MEETSUM_WORKER_HEALTH_PORT (default 3101), bound to
 * MEETSUM_WORKER_HEALTH_HOST (default 0.0.0.0 inside the container; the port
 * is never published in compose).
 *
 * - `GET /live`: 200 while the event loop lag is under 2 s, else 503.
 * - `GET /ready`: Redis PING (1 s), database `select 1` (2 s) and every
 *   started BullMQ worker reporting `isRunning()`. 200 or 503 with
 *   `{ status, checks: { redis, database, workers } }`; never error text,
 *   hosts or versions.
 * Anything else is 404. Only GET/HEAD.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { checkDatabase, runCheck, REDIS_TIMEOUT_MS, type CheckResult } from "@/lib/health/checks"
import { getLogger } from "@/lib/log"

export const DEFAULT_WORKER_HEALTH_PORT = 3101
export const MAX_EVENT_LOOP_LAG_MS = 2_000

export type HealthWorker = { isRunning(): boolean }

export type WorkerHealthDeps = {
  /** The started BullMQ workers (undefined entries are workers that are off). */
  workers: () => Array<HealthWorker | undefined>
  /** Redis PING through an existing worker connection. */
  pingRedis: () => Promise<unknown>
  database?: () => Promise<CheckResult>
  /** Current event-loop lag in ms (see `createLagMonitor`). */
  eventLoopLagMs: () => number
}

export type WorkerReadiness = {
  status: "ok" | "fail"
  checks: { redis: CheckResult; database: CheckResult; workers: CheckResult }
}

export async function workerReadiness(deps: WorkerHealthDeps): Promise<WorkerReadiness> {
  const started = deps.workers().filter((worker): worker is HealthWorker => Boolean(worker))
  const [redis, database] = await Promise.all([
    runCheck(async () => {
      const reply = await deps.pingRedis()

      if (reply !== "PONG") throw new Error("unexpected ping reply")
    }, REDIS_TIMEOUT_MS),
    (deps.database ?? (() => checkDatabase()))().catch((): CheckResult => "fail"),
  ])
  let workers: CheckResult = "fail"

  try {
    workers = started.length > 0 && started.every((worker) => worker.isRunning()) ? "ok" : "fail"
  } catch {
    workers = "fail"
  }

  const checks = { redis, database, workers }

  return { status: Object.values(checks).includes("fail") ? "fail" : "ok", checks }
}

function send(res: ServerResponse, status: number, body: unknown, head: boolean) {
  const payload = JSON.stringify(body)

  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) })
  res.end(head ? undefined : payload)
}

export function createWorkerHealthHandler(deps: WorkerHealthDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const head = req.method === "HEAD"

    if (req.method !== "GET" && !head) return send(res, 405, { status: "method_not_allowed" }, false)

    const path = (req.url ?? "/").split("?")[0]

    try {
      if (path === "/live") {
        const ok = deps.eventLoopLagMs() < MAX_EVENT_LOOP_LAG_MS

        return send(res, ok ? 200 : 503, { status: ok ? "ok" : "fail" }, head)
      }

      if (path === "/ready") {
        const report = await workerReadiness(deps)

        return send(res, report.status === "ok" ? 200 : 503, report, head)
      }

      return send(res, 404, { status: "not_found" }, head)
    } catch {
      return send(res, 503, { status: "fail" }, head)
    }
  }
}

/**
 * Event-loop lag: a 500 ms timer measures how late it fires; the lag is the
 * worst delay seen in the last two ticks. The timer is unref'd.
 */
export function createLagMonitor(intervalMs = 500) {
  let last = performance.now()
  let lag = 0
  let previous = 0
  const timer = setInterval(() => {
    const now = performance.now()
    const delay = Math.max(0, now - last - intervalMs)

    lag = Math.max(delay, previous)
    previous = delay
    last = now
  }, intervalMs)

  timer.unref?.()

  return {
    lagMs: () => Math.max(lag, Math.max(0, performance.now() - last - intervalMs)),
    stop: () => clearInterval(timer),
  }
}

export function workerHealthPort(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.MEETSUM_WORKER_HEALTH_PORT)

  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_WORKER_HEALTH_PORT
}

export function workerHealthHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEETSUM_WORKER_HEALTH_HOST?.trim() || "0.0.0.0"
}

/** Starts the server; resolves once listening. Errors are logged, never thrown. */
export function startWorkerHealthServer(
  deps: WorkerHealthDeps,
  options: { port?: number; host?: string } = {}
): Promise<Server | undefined> {
  const port = options.port ?? workerHealthPort()
  const host = options.host ?? workerHealthHost()
  const server = createServer((req, res) => void createWorkerHealthHandler(deps)(req, res))
  const log = getLogger({ component: "worker-health" })

  return new Promise((resolve) => {
    server.once("error", (error) => {
      log.error({ err: error }, "worker health server failed to start")
      resolve(undefined)
    })
    server.listen(port, host, () => {
      log.info({ port }, "worker health server listening")
      resolve(server)
    })
  })
}
