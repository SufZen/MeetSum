/**
 * M10 B3: the worker health server. /live follows the event-loop lag;
 * /ready needs Redis PING, the database and every started BullMQ worker
 * running. Responses carry only ok/fail values.
 */
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"

import { afterEach, describe, expect, it } from "vitest"

import {
  DEFAULT_WORKER_HEALTH_PORT,
  startWorkerHealthServer,
  workerHealthHost,
  workerHealthPort,
  workerReadiness,
  type WorkerHealthDeps,
} from "@/lib/worker-health/server"

const running = { isRunning: () => true }
const stopped = { isRunning: () => false }

function deps(overrides: Partial<WorkerHealthDeps> = {}): WorkerHealthDeps {
  return {
    workers: () => [running, undefined, running],
    pingRedis: async () => "PONG",
    database: async () => "ok",
    eventLoopLagMs: () => 5,
    ...overrides,
  }
}

let server: Server | undefined

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

async function start(d: WorkerHealthDeps) {
  server = await startWorkerHealthServer(d, { port: 0, host: "127.0.0.1" })
  const { port } = server!.address() as AddressInfo

  return (path: string, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, { method })
}

describe("worker health", () => {
  it("ready: ok when Redis, the database and all started workers are up", async () => {
    expect(await workerReadiness(deps())).toEqual({ status: "ok", checks: { redis: "ok", database: "ok", workers: "ok" } })
  })

  it("ready: fails on a stopped worker, a Redis error or a database failure", async () => {
    expect((await workerReadiness(deps({ workers: () => [running, stopped] }))).checks.workers).toBe("fail")
    expect((await workerReadiness(deps({ pingRedis: async () => Promise.reject(new Error("ECONNREFUSED redis:6379")) }))).checks.redis).toBe("fail")
    expect((await workerReadiness(deps({ database: async () => "fail" }))).status).toBe("fail")
    expect((await workerReadiness(deps({ workers: () => [] }))).checks.workers).toBe("fail")
  })

  it("serves /live and /ready over HTTP with 200/503 and no error text", async () => {
    const get = await start(deps({ pingRedis: async () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:6379")) }))

    const live = await get("/live")

    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({ status: "ok" })

    const ready = await get("/ready")
    const text = await ready.text()

    expect(ready.status).toBe(503)
    expect(JSON.parse(text)).toEqual({ status: "fail", checks: { redis: "fail", database: "ok", workers: "ok" } })
    expect(text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|6379/)
    expect((await get("/metrics")).status).toBe(404)
    expect((await get("/live", "POST")).status).toBe(405)
  })

  it("/live fails when the event loop lags 2 s or more", async () => {
    const get = await start(deps({ eventLoopLagMs: () => 2_500 }))

    expect((await get("/live")).status).toBe(503)
  })

  it("reads MEETSUM_WORKER_HEALTH_PORT/HOST with safe defaults", () => {
    expect(workerHealthPort({} as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_WORKER_HEALTH_PORT)
    expect(workerHealthPort({ MEETSUM_WORKER_HEALTH_PORT: "4100" } as unknown as NodeJS.ProcessEnv)).toBe(4100)
    expect(workerHealthPort({ MEETSUM_WORKER_HEALTH_PORT: "nope" } as unknown as NodeJS.ProcessEnv)).toBe(3101)
    expect(workerHealthHost({} as unknown as NodeJS.ProcessEnv)).toBe("0.0.0.0")
  })
})
