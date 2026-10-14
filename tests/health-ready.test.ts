/**
 * M10 B3 + security check 3: /api/health/ready runs the database, Redis,
 * storage and migrations checks with short timeouts, answers 200 or 503 with
 * `{ status, checks }` and never reveals error text, hosts or versions.
 * /api/health/live makes no dependency calls; both probes are rate-limited
 * per IP with the in-process limiter.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  checkDatabase,
  checkMigrations,
  checkRedis,
  checkStorage,
  latestMigrationFileVersion,
} from "@/lib/health/checks"
import { runReadiness } from "@/lib/health/ready"
import { resetRateLimitsForTesting, setRateLimitRedisForTesting } from "@/lib/rate-limit"
import { FakeRateLimitRedis } from "@/tests/helpers/fake-redis"

const prod = { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv
const dev = { NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv
const hang = () => new Promise<never>(() => undefined)
const routeCtx = { params: Promise.resolve({}) }

describe("readiness checks", () => {
  it("database: ok, fail on error, fail on a 2 s timeout, skip/fail when unconfigured", async () => {
    vi.useFakeTimers()

    try {
      expect(await checkDatabase({ db: async () => ({ query: async () => ({ rows: [{}] }) }) })).toBe("ok")
      expect(await checkDatabase({ db: async () => ({ query: async () => Promise.reject(new Error("ECONNREFUSED db.internal:5432")) }) })).toBe("fail")

      const slow = checkDatabase({ db: async () => ({ query: hang }) })

      await vi.advanceTimersByTimeAsync(2_001)
      expect(await slow).toBe("fail")
    } finally {
      vi.useRealTimers()
    }

    expect(await checkDatabase({ env: dev })).toBe("skip")
    expect(await checkDatabase({ env: prod })).toBe("fail")
  })

  it("redis: PING must answer PONG within 1 s; skip when REDIS_URL is unset outside production", async () => {
    vi.useFakeTimers()

    try {
      expect(await checkRedis({ redis: async () => ({ ping: async () => "PONG" }) })).toBe("ok")
      expect(await checkRedis({ redis: async () => ({ ping: async () => "LOADING" }) })).toBe("fail")

      const slow = checkRedis({ redis: async () => ({ ping: hang }) })

      await vi.advanceTimersByTimeAsync(1_001)
      expect(await slow).toBe("fail")
    } finally {
      vi.useRealTimers()
    }

    expect(await checkRedis({ env: dev })).toBe("skip")
    expect(await checkRedis({ env: prod })).toBe("fail")
  })

  it("storage: HeadBucket on S3_BUCKET; skip when S3_ENDPOINT is unset outside production", async () => {
    const probe = vi.fn(async () => undefined)

    expect(await checkStorage({ env: { S3_BUCKET: "media" } as unknown as NodeJS.ProcessEnv, probe })).toBe("ok")
    expect(probe).toHaveBeenCalledWith("media", expect.any(AbortSignal))
    expect(await checkStorage({ probe: async () => Promise.reject(new Error("NoSuchBucket")) })).toBe("fail")
    expect(await checkStorage({ env: dev })).toBe("skip")
    expect(await checkStorage({ env: prod })).toBe("fail")
  })

  it("migrations: ok when the database is not behind the newest migration file", async () => {
    const db = (version: string | null) => async () => ({ query: async () => ({ rows: [{ version }] }) })

    expect(await checkMigrations({ db: db("032"), fileVersion: "032" })).toBe("ok")
    expect(await checkMigrations({ db: db("033"), fileVersion: "032" })).toBe("ok")
    expect(await checkMigrations({ db: db("031"), fileVersion: "032" })).toBe("fail")
    expect(await checkMigrations({ db: db(null), fileVersion: "032" })).toBe("fail")
    expect(await checkMigrations({ db: async () => ({ query: async () => Promise.reject(new Error("no table")) }), fileVersion: "032" })).toBe("fail")
  })

  it("reads the newest migration version from db/migrations", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "migrations-"))

    for (const name of ["001_init.sql", "010_more.sql", "README.md", "009_x.sql"]) writeFileSync(path.join(dir, name), "")
    expect(latestMigrationFileVersion(dir)).toBe("010")
    expect(Number(latestMigrationFileVersion())).toBeGreaterThanOrEqual(32)
  })

  it("aggregates: any fail is 503-worthy, skip is not", async () => {
    expect(
      await runReadiness({ database: async () => "ok", redis: async () => "skip", storage: async () => "ok", migrations: async () => "ok" })
    ).toEqual({ status: "ok", checks: { database: "ok", redis: "skip", storage: "ok", migrations: "ok" } })
    expect(
      (await runReadiness({ database: async () => "ok", redis: async () => "fail", storage: async () => "ok", migrations: async () => Promise.reject(new Error("x")) }))
    ).toEqual({ status: "fail", checks: { database: "ok", redis: "fail", storage: "ok", migrations: "fail" } })
  })
})

describe("health routes", () => {
  beforeEach(() => {
    vi.resetModules()
    resetRateLimitsForTesting()
  })

  afterEach(() => {
    vi.doUnmock("@/lib/health/ready")
    vi.unstubAllEnvs()
    setRateLimitRedisForTesting(undefined)
  })

  it("ready returns 503 with only ok/fail/skip values (no error text, hosts or versions)", async () => {
    vi.doMock("@/lib/health/ready", () => ({
      getReadiness: async () => ({ status: "fail", checks: { database: "fail", redis: "ok", storage: "skip", migrations: "ok" } }),
    }))

    const { GET } = await import("@/app/api/health/ready/route")
    const response = await GET(new Request("http://localhost/api/health/ready"), routeCtx)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(body).toEqual({ status: "fail", checks: { database: "fail", redis: "ok", storage: "skip", migrations: "ok" } })
  })

  it("ready returns 200 when nothing fails", async () => {
    vi.doMock("@/lib/health/ready", () => ({
      getReadiness: async () => ({ status: "ok", checks: { database: "ok", redis: "ok", storage: "ok", migrations: "ok" } }),
    }))

    const { GET } = await import("@/app/api/health/ready/route")

    expect((await GET(new Request("http://localhost/api/health/ready"), routeCtx)).status).toBe(200)
  })

  it("live answers 200 without touching Redis, even on the Redis backend", async () => {
    const redis = new FakeRateLimitRedis()

    setRateLimitRedisForTesting(redis)
    vi.stubEnv("MEETSUM_RATE_LIMIT_BACKEND", "redis")

    const { GET } = await import("@/app/api/health/live/route")
    const response = await GET(new Request("http://localhost/api/health/live"), routeCtx)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
    expect(redis.calls).toHaveLength(0)
  })

  it("rate-limits the probes per IP (120/min)", async () => {
    const { GET } = await import("@/app/api/health/live/route")
    const request = () => new Request("http://localhost/api/health/live", { headers: { "x-real-ip": "198.51.100.20" } })
    let last = 200

    for (let index = 0; index < 121; index += 1) last = (await GET(request(), routeCtx)).status

    expect(last).toBe(429)
    expect((await GET(new Request("http://localhost/api/health/live", { headers: { "x-real-ip": "198.51.100.21" } }), routeCtx)).status).toBe(200)
  })

  it("/api/health reports the package.json version and real Redis/storage states", async () => {
    const { default: packageJson } = await import("@/package.json")
    const { GET } = await import("@/app/api/health/route")
    const body = await (await GET(new Request("http://localhost/api/health"), routeCtx)).json()

    expect(body.version).toBe(packageJson.version)
    expect(["ok", "degraded", "not_configured"]).toContain(body.services.redis)
    expect(["ok", "degraded", "not_configured"]).toContain(body.services.storage)
  })
})
