/**
 * M10 B4 (docs/parity/m10.md, "Rate limiter (R1)"): the Redis backend.
 *
 * - With the Lua-compatible fake (tests/helpers/fake-redis.ts): the Redis
 *   backend gives the same answers as the memory backend (single and
 *   multi-window), keys are `rl:<preset>:<sha256>` with no raw IP or user id,
 *   and the limit is shared across "instances".
 * - One real-Redis test runs only when REDIS_URL is set (the CI e2e jobs).
 */
import { createHash } from "node:crypto"

import { Redis } from "ioredis"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  checkRateLimit,
  checkRateLimitWindows,
  llmOnDemandWindows,
  RATE_LIMIT_PRESETS,
  rateLimitBackend,
  rateLimitRequest,
  resetRateLimitsForTesting,
  setRateLimitRedisForTesting,
  type RateLimitConfig,
  type RateLimitResult,
} from "@/lib/rate-limit"
import { checkRedisRateLimitWindows, redisRateLimitKey } from "@/lib/rate-limit/redis"
import { FakeRateLimitRedis } from "@/tests/helpers/fake-redis"

const sha = (value: string) => createHash("sha256").update(value).digest("hex")

describe("Redis rate limiter (fake)", () => {
  let redis: FakeRateLimitRedis

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"))
    redis = new FakeRateLimitRedis()
    resetRateLimitsForTesting()
  })

  afterEach(() => {
    setRateLimitRedisForTesting(undefined)
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  async function run(backend: "memory" | "redis", steps: Array<{ advance: number; key: string; windows: RateLimitConfig[] }>) {
    resetRateLimitsForTesting()
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"))
    setRateLimitRedisForTesting(backend === "redis" ? new FakeRateLimitRedis() : undefined)
    vi.stubEnv("MEETSUM_RATE_LIMIT_BACKEND", backend)

    const results: RateLimitResult[] = []

    for (const step of steps) {
      vi.advanceTimersByTime(step.advance)
      results.push(
        step.windows.length === 1 ? await checkRateLimit(step.key, step.windows[0]) : await checkRateLimitWindows(step.key, step.windows)
      )
    }

    return results
  }

  it("selects the backend from MEETSUM_RATE_LIMIT_BACKEND and REDIS_URL", () => {
    expect(rateLimitBackend({ MEETSUM_RATE_LIMIT_BACKEND: "memory", REDIS_URL: "redis://r:6379" } as unknown as NodeJS.ProcessEnv)).toBe("memory")
    expect(rateLimitBackend({ MEETSUM_RATE_LIMIT_BACKEND: "redis" } as unknown as NodeJS.ProcessEnv)).toBe("redis")
    expect(rateLimitBackend({ REDIS_URL: "redis://r:6379" } as unknown as NodeJS.ProcessEnv)).toBe("redis")
    expect(rateLimitBackend({} as unknown as NodeJS.ProcessEnv)).toBe("memory")
  })

  it("matches the memory backend on a single window (allow, block, reset)", async () => {
    const config: RateLimitConfig = { name: "api", maxRequests: 3, windowMs: 1000 }
    const steps = [0, 10, 10, 10, 500, 600, 10, 2000].map((advance) => ({ advance, key: "1.2.3.4", windows: [config] }))

    expect(await run("redis", steps)).toEqual(await run("memory", steps))
  })

  it("matches the memory backend on the llmOnDemand multi-window budget", async () => {
    const windows = [...llmOnDemandWindows(false)]
    const steps = Array.from({ length: 16 }, (_value, index) => ({ advance: index % 2 === 0 ? 61_000 : 5, key: "llm:ws:user", windows }))

    const redisResults = await run("redis", steps)

    expect(redisResults).toEqual(await run("memory", steps))
    expect(redisResults.some((result) => !result.allowed)).toBe(true)
  })

  it("hashes keys: rl:<preset>:<sha256(key)>, never a raw IP or user id", async () => {
    setRateLimitRedisForTesting(redis)
    vi.stubEnv("MEETSUM_RATE_LIMIT_BACKEND", "redis")

    await rateLimitRequest(new Request("http://x", { headers: { "x-real-ip": "203.0.113.9" } }), RATE_LIMIT_PRESETS.search)
    await checkRateLimit("ask:ws_1:user_42", RATE_LIMIT_PRESETS.ask)
    await checkRateLimit("bot-join:user:u1", { maxRequests: 5, windowMs: 60_000 })

    expect(redis.keys().sort()).toEqual(
      [`rl:search:${sha("203.0.113.9")}`, `rl:ask:${sha("ask:ws_1:user_42")}`, `rl:custom:${sha("bot-join:user:u1")}`].sort()
    )
    expect(redis.keys().join(" ")).not.toMatch(/203\.0\.113\.9|user_42|u1\b/)
    expect(redisRateLimitKey("api", "k")).toBe(`rl:api:${sha("k")}`)
  })

  it("shares one budget across instances (one Redis, two callers)", async () => {
    const config: RateLimitConfig = { name: "api", maxRequests: 2, windowMs: 60_000 }

    expect((await checkRedisRateLimitWindows(redis, config.name, "k", [config])).allowed).toBe(true)
    expect((await checkRedisRateLimitWindows(redis, config.name, "k", [config])).allowed).toBe(true)
    // The "second instance" has no local memory but sees the shared count.
    expect((await checkRedisRateLimitWindows(redis, config.name, "k", [config])).allowed).toBe(false)
  })

  it("does not count blocked requests and expires the key after the longest window", async () => {
    const config: RateLimitConfig = { name: "api", maxRequests: 1, windowMs: 1000 }
    const now = Date.now()

    await checkRedisRateLimitWindows(redis, "api", "k", [config], now)
    await checkRedisRateLimitWindows(redis, "api", "k", [config], now + 1)
    await checkRedisRateLimitWindows(redis, "api", "k", [config], now + 2)

    expect(redis.sets.get(redisRateLimitKey("api", "k"))).toHaveLength(1)
    expect(redis.expiresAt.get(redisRateLimitKey("api", "k"))).toBe(now + 2 + 1000)
  })
})

describe.runIf(Boolean(process.env.REDIS_URL))("Redis rate limiter (real Redis, REDIS_URL)", () => {
  let client: Redis

  beforeEach(() => {
    client = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 1 })
  })

  afterEach(async () => {
    await client.quit()
  })

  it("runs the Lua script: allows up to the limit, then blocks", async () => {
    const config: RateLimitConfig = { name: "vitest", maxRequests: 2, windowMs: 5_000 }
    const key = `real-${Date.now()}-${Math.random()}`

    try {
      const results = []

      for (let index = 0; index < 3; index += 1) results.push(await checkRedisRateLimitWindows(client, config.name, key, [config]))

      expect(results.map((result) => result.allowed)).toEqual([true, true, false])
      expect(results[0].remaining).toBe(1)
      expect(await client.pttl(redisRateLimitKey(config.name, key))).toBeGreaterThan(0)
    } finally {
      await client.del(redisRateLimitKey(config.name, key))
    }
  })
})
