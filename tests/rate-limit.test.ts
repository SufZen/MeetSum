import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  applyRateLimitHeaders,
  checkRateLimit,
  extractRateLimitKey,
  RATE_LIMIT_PRESETS,
  type RateLimitConfig,
  rateLimitRequest,
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

describe("rateLimitRequest", () => {
  it("returns headers and no blocked response for allowed requests", () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    })

    const result = rateLimitRequest(request, { maxRequests: 100, windowMs: 60_000 })

    expect(result.blocked).toBeUndefined()
    expect(result.headers["X-RateLimit-Limit"]).toBe("100")
    expect(result.headers["X-RateLimit-Remaining"]).toBeTruthy()
  })

  it("returns a 429 response when rate limit is exceeded", () => {
    const config = { maxRequests: 2, windowMs: 60_000 }
    const key = "test-429-response"

    for (let i = 0; i < 2; i++) {
      rateLimitRequest(new Request("http://localhost"), config, key)
    }

    const result = rateLimitRequest(new Request("http://localhost"), config, key)

    expect(result.blocked).toBeTruthy()
    expect(result.blocked!.status).toBe(429)
    expect(result.blocked!.headers.get("Retry-After")).toBeTruthy()
    expect(result.blocked!.headers.get("Content-Type")).toBe("application/json")
  })

  it("skips rate limiting when MEETSUM_RATE_LIMIT=false", () => {
    const original = process.env.MEETSUM_RATE_LIMIT
    process.env.MEETSUM_RATE_LIMIT = "false"

    const result = rateLimitRequest(
      new Request("http://localhost"),
      { maxRequests: 1, windowMs: 60_000 },
      "test-disabled"
    )

    expect(result.blocked).toBeUndefined()
    expect(Object.keys(result.headers)).toHaveLength(0)

    process.env.MEETSUM_RATE_LIMIT = original
  })
})

describe("extractRateLimitKey", () => {
  it("uses the rightmost (trusted-proxy) IP from x-forwarded-for", () => {
    // The proxy appends the real peer IP on the right; leftmost entries are
    // client-supplied and spoofable, so the rightmost is the trustworthy key.
    const request = new Request("http://localhost", {
      headers: { "x-forwarded-for": "192.168.1.1, 10.0.0.1" },
    })

    const key = extractRateLimitKey(request)

    expect(key).toBe("10.0.0.1")
  })

  it("falls back to x-real-ip when no forwarded-for is present", () => {
    const request = new Request("http://localhost", {
      headers: { "x-real-ip": "203.0.113.9" },
    })

    expect(extractRateLimitKey(request)).toBe("203.0.113.9")
  })

  it("appends suffix when provided", () => {
    const request = new Request("http://localhost", {
      headers: { "x-forwarded-for": "10.0.0.5" },
    })

    const key = extractRateLimitKey(request, "ask")

    expect(key).toBe("10.0.0.5:ask")
  })

  it("falls back to 'unknown' when no forwarded header", () => {
    const request = new Request("http://localhost")

    const key = extractRateLimitKey(request)

    expect(key).toBe("unknown")
  })
})
