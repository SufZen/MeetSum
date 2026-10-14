/**
 * M10 B4 + security check 4: when Redis is down or slow, the cost/abuse
 * presets (share verify, ask, on-demand LLM, auth, exports, search) deny;
 * every other preset falls back to the per-instance memory limiter. The
 * outage is logged at most once a minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { limitLlmOnDemand } from "@/lib/intelligence/on-demand"
import {
  checkRateLimit,
  RATE_LIMIT_PRESETS,
  rateLimitRequest,
  resetRateLimitsForTesting,
  setRateLimitRedisForTesting,
} from "@/lib/rate-limit"
import { FakeRateLimitRedis } from "@/tests/helpers/fake-redis"
import { captureLogs, restoreLogs } from "@/tests/helpers/capture-logs"

const FAIL_CLOSED = ["shareVerify", "ask", "integrationsOAuth", "exports", "search"] as const
const FALL_BACK = ["api", "aiProcessing", "share", "publicAccess", "health", "admin", "threads", "integrationsWrite", "integrationsSend", "webhookTest"] as const

describe("rate limiter Redis failure policy", () => {
  beforeEach(() => {
    resetRateLimitsForTesting()
    vi.stubEnv("MEETSUM_RATE_LIMIT_BACKEND", "redis")
  })

  afterEach(() => {
    setRateLimitRedisForTesting(undefined)
    vi.unstubAllEnvs()
    restoreLogs()
  })

  it("flags exactly the cost/abuse presets as fail-closed", () => {
    for (const name of FAIL_CLOSED) expect(RATE_LIMIT_PRESETS[name].failClosed, name).toBe(true)
    for (const name of FALL_BACK) expect("failClosed" in RATE_LIMIT_PRESETS[name], name).toBe(false)
    for (const window of [...RATE_LIMIT_PRESETS.llmOnDemand.writer, ...RATE_LIMIT_PRESETS.llmOnDemand.nonWriter]) {
      expect(window.failClosed).toBe(true)
    }
    expect(RATE_LIMIT_PRESETS.shareVerify.name).toBe("share-verify")
    expect(RATE_LIMIT_PRESETS.integrationsOAuth.name).toBe("auth")
  })

  it.each(FAIL_CLOSED)("denies %s when Redis is down", async (name) => {
    const redis = new FakeRateLimitRedis()

    redis.down = true
    setRateLimitRedisForTesting(redis)

    const { blocked } = await rateLimitRequest(new Request("http://x"), RATE_LIMIT_PRESETS[name], `k:${name}`)

    expect(blocked?.status).toBe(429)
  })

  it.each(FALL_BACK)("falls back to memory for %s when Redis is down", async (name) => {
    const redis = new FakeRateLimitRedis()

    redis.down = true
    setRateLimitRedisForTesting(redis)

    const preset = RATE_LIMIT_PRESETS[name]
    const results = []

    for (let index = 0; index <= preset.maxRequests; index += 1) results.push(await checkRateLimit(`k:${name}`, preset))

    expect(results.slice(0, preset.maxRequests).every((result) => result.allowed)).toBe(true)
    // The memory fallback still enforces the limit per instance.
    expect(results[preset.maxRequests].allowed).toBe(false)
  })

  it("fails closed for the on-demand LLM budget", async () => {
    setRateLimitRedisForTesting(null)

    const response = await limitLlmOnDemand({ workspaceId: "ws_1", actorKey: "user:u1", canWrite: true })

    expect(response?.status).toBe(429)
  })

  it("treats a slow Redis (> 500 ms) like a down one", async () => {
    vi.useFakeTimers()

    try {
      const redis = new FakeRateLimitRedis()

      redis.delayMs = 5_000
      setRateLimitRedisForTesting(redis)

      const ask = checkRateLimit("k", RATE_LIMIT_PRESETS.ask)
      const api = checkRateLimit("k", RATE_LIMIT_PRESETS.api)

      await vi.advanceTimersByTimeAsync(600)

      expect((await ask).allowed).toBe(false)
      expect((await api).allowed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("logs the outage at most once a minute, without keys or IPs", async () => {
    const logs = captureLogs()

    setRateLimitRedisForTesting(null)
    await checkRateLimit("198.51.100.7", RATE_LIMIT_PRESETS.api)
    await checkRateLimit("198.51.100.7", RATE_LIMIT_PRESETS.search)
    await checkRateLimit("198.51.100.7", RATE_LIMIT_PRESETS.admin)

    expect(logs.at("warn")).toHaveLength(1)
    expect(logs[0]).toMatchObject({ component: "rate-limit", preset: "api", failClosed: false })
    expect(logs.text()).not.toContain("198.51.100.7")
  })

  it("MEETSUM_RATE_LIMIT=false still disables limiting", async () => {
    vi.stubEnv("MEETSUM_RATE_LIMIT", "false")
    setRateLimitRedisForTesting(null)

    expect((await rateLimitRequest(new Request("http://x"), RATE_LIMIT_PRESETS.ask, "k")).blocked).toBeUndefined()
  })
})
