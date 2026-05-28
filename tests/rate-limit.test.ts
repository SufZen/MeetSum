import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  applyRateLimitHeaders,
  checkRateLimit,
  RATE_LIMIT_PRESETS,
  type RateLimitConfig,
} from "@/lib/rate-limit"

describe("rate limiter", () => {
  const config: RateLimitConfig = { maxRequests: 3, windowMs: 1000 }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("allows requests under the limit", () => {
    const key = "test-allow"

    const r1 = checkRateLimit(key, config)
    expect(r1.allowed).toBe(true)
    expect(r1.remaining).toBe(2)

    const r2 = checkRateLimit(key, config)
    expect(r2.allowed).toBe(true)
    expect(r2.remaining).toBe(1)

    const r3 = checkRateLimit(key, config)
    expect(r3.allowed).toBe(true)
    expect(r3.remaining).toBe(0)
  })

  it("blocks requests over the limit", () => {
    const key = "test-block"

    for (let i = 0; i < 3; i++) {
      checkRateLimit(key, config)
    }

    const blocked = checkRateLimit(key, config)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it("allows requests again after the window expires", () => {
    const key = "test-window"

    for (let i = 0; i < 3; i++) {
      checkRateLimit(key, config)
    }

    // Advance past the window
    vi.advanceTimersByTime(1100)

    const result = checkRateLimit(key, config)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
  })

  it("isolates different keys", () => {
    const key1 = "user-a"
    const key2 = "user-b"

    for (let i = 0; i < 3; i++) {
      checkRateLimit(key1, config)
    }

    const result = checkRateLimit(key2, config)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
  })

  it("returns correct limit value", () => {
    const result = checkRateLimit("test-limit", config)
    expect(result.limit).toBe(3)
  })

  it("returns a valid reset timestamp", () => {
    const result = checkRateLimit("test-reset", config)
    expect(result.resetMs).toBeGreaterThan(Date.now())
  })
})

describe("rate limit headers", () => {
  it("sets X-RateLimit headers on Response", () => {
    const headers = new Headers()

    applyRateLimitHeaders(headers, {
      allowed: true,
      remaining: 5,
      resetMs: 1700000000000,
      limit: 10,
    })

    expect(headers.get("X-RateLimit-Limit")).toBe("10")
    expect(headers.get("X-RateLimit-Remaining")).toBe("5")
    expect(headers.get("X-RateLimit-Reset")).toBeTruthy()
  })
})

describe("rate limit presets", () => {
  it("has sensible defaults for all presets", () => {
    expect(RATE_LIMIT_PRESETS.api.maxRequests).toBeGreaterThanOrEqual(60)
    expect(RATE_LIMIT_PRESETS.aiProcessing.maxRequests).toBeLessThanOrEqual(20)
    expect(RATE_LIMIT_PRESETS.exports.maxRequests).toBeGreaterThan(0)
    expect(RATE_LIMIT_PRESETS.share.maxRequests).toBeGreaterThan(0)
    expect(RATE_LIMIT_PRESETS.publicAccess.maxRequests).toBeGreaterThan(0)
    expect(RATE_LIMIT_PRESETS.admin.maxRequests).toBeGreaterThan(0)
  })

  it("all presets have a window of at least 1 second", () => {
    for (const preset of Object.values(RATE_LIMIT_PRESETS)) {
      expect(preset.windowMs).toBeGreaterThanOrEqual(1000)
    }
  })
})
