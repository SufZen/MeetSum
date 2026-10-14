import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  applyRateLimitHeaders,
  checkRateLimit,
  checkRateLimitWindows,
  extractRateLimitKey,
  getClientIp,
  llmOnDemandWindows,
  RATE_LIMIT_PRESETS,
  type RateLimitConfig,
  type RateLimitStore,
  rateLimitRequest,
  setRateLimitStoreForTesting,
} from "@/lib/rate-limit"

describe("rate limiter fails closed", () => {
  const broken = {
    get() {
      throw new Error("store unavailable")
    },
    set() {
      throw new Error("store unavailable")
    },
    delete() {
      throw new Error("store unavailable")
    },
    clear() {},
    [Symbol.iterator]() {
      throw new Error("store unavailable")
    },
  } as unknown as RateLimitStore

  afterEach(() => {
    setRateLimitStoreForTesting(undefined)
    delete process.env.MEETSUM_RATE_LIMIT
  })

  it("denies when its store is unavailable", async () => {
    setRateLimitStoreForTesting(broken)

    expect((await checkRateLimit("k", { maxRequests: 5, windowMs: 60_000 })).allowed).toBe(false)
    expect((await checkRateLimitWindows("k", llmOnDemandWindows(true))).allowed).toBe(false)

    const { blocked } = await rateLimitRequest(new Request("http://x"), { maxRequests: 5, windowMs: 60_000 }, "k")

    expect(blocked?.status).toBe(429)
    expect(Number(blocked?.headers.get("Retry-After"))).toBeGreaterThan(0)
  })
})

describe("multi-window rate limit (llmOnDemand)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("has writer and non-writer presets", async () => {
    // M10 R1: the presets also carry their Redis namespace and fail-closed flag.
    const llm = { name: "llmOnDemand", failClosed: true }

    expect(RATE_LIMIT_PRESETS.llmOnDemand.writer).toEqual([
      { ...llm, maxRequests: 3, windowMs: 60_000 },
      { ...llm, maxRequests: 20, windowMs: 3_600_000 },
    ])
    expect(RATE_LIMIT_PRESETS.llmOnDemand.nonWriter).toEqual([
      { ...llm, maxRequests: 2, windowMs: 60_000 },
      { ...llm, maxRequests: 10, windowMs: 3_600_000 },
    ])
    expect(llmOnDemandWindows(true)).toBe(RATE_LIMIT_PRESETS.llmOnDemand.writer)
    expect(llmOnDemandWindows(false)).toBe(RATE_LIMIT_PRESETS.llmOnDemand.nonWriter)
  })

  it("enforces the per-minute and the per-hour window", async () => {
    const windows = llmOnDemandWindows(false)
    const key = "llm-test:viewer"

    expect((await checkRateLimitWindows(key, windows)).allowed).toBe(true)
    expect((await checkRateLimitWindows(key, windows)).allowed).toBe(true)

    const blocked = await checkRateLimitWindows(key, windows)

    expect(blocked.allowed).toBe(false)
    expect(blocked.resetMs - Date.now()).toBeLessThanOrEqual(60_000)

    // 10 per hour: after the minute resets, 8 more are allowed, then blocked.
    for (let index = 0; index < 4; index += 1) {
      vi.advanceTimersByTime(61_000)
      expect((await checkRateLimitWindows(key, windows)).allowed).toBe(true)
      expect((await checkRateLimitWindows(key, windows)).allowed).toBe(true)
    }
    vi.advanceTimersByTime(61_000)

    const hourly = await checkRateLimitWindows(key, windows)

    expect(hourly.allowed).toBe(false)
    expect(hourly.resetMs - Date.now()).toBeGreaterThan(60_000)
  })
})

describe("rate limiter", () => {
  const config: RateLimitConfig = { maxRequests: 3, windowMs: 1000 }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("allows requests under the limit", async () => {
    const key = "test-allow"

    const r1 = await checkRateLimit(key, config)
    expect(r1.allowed).toBe(true)
    expect(r1.remaining).toBe(2)

    const r2 = await checkRateLimit(key, config)
    expect(r2.allowed).toBe(true)
    expect(r2.remaining).toBe(1)

    const r3 = await checkRateLimit(key, config)
    expect(r3.allowed).toBe(true)
    expect(r3.remaining).toBe(0)
  })

  it("blocks requests over the limit", async () => {
    const key = "test-block"

    for (let i = 0; i < 3; i++) {
      await checkRateLimit(key, config)
    }

    const blocked = await checkRateLimit(key, config)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it("allows requests again after the window expires", async () => {
    const key = "test-window"

    for (let i = 0; i < 3; i++) {
      await checkRateLimit(key, config)
    }

    // Advance past the window
    vi.advanceTimersByTime(1100)

    const result = await checkRateLimit(key, config)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
  })

  it("isolates different keys", async () => {
    const key1 = "user-a"
    const key2 = "user-b"

    for (let i = 0; i < 3; i++) {
      await checkRateLimit(key1, config)
    }

    const result = await checkRateLimit(key2, config)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
  })

  it("returns correct limit value", async () => {
    const result = await checkRateLimit("test-limit", config)
    expect(result.limit).toBe(3)
  })

  it("returns a valid reset timestamp", async () => {
    const result = await checkRateLimit("test-reset", config)
    expect(result.resetMs).toBeGreaterThan(Date.now())
  })
})

describe("rate limit headers", () => {
  it("sets X-RateLimit headers on Response", async () => {
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
  it("has sensible defaults for all presets", async () => {
    expect(RATE_LIMIT_PRESETS.api.maxRequests).toBeGreaterThanOrEqual(60)
    expect(RATE_LIMIT_PRESETS.aiProcessing.maxRequests).toBeLessThanOrEqual(20)
    expect(RATE_LIMIT_PRESETS.exports.maxRequests).toBeGreaterThan(0)
    expect(RATE_LIMIT_PRESETS.share.maxRequests).toBeGreaterThan(0)
    expect(RATE_LIMIT_PRESETS.publicAccess.maxRequests).toBeGreaterThan(0)
    expect(RATE_LIMIT_PRESETS.admin.maxRequests).toBeGreaterThan(0)
  })

  it("all presets have a window of at least 1 second", async () => {
    const { llmOnDemand, ...single } = RATE_LIMIT_PRESETS

    for (const preset of [...Object.values(single), ...llmOnDemand.writer, ...llmOnDemand.nonWriter]) {
      expect(preset.windowMs).toBeGreaterThanOrEqual(1000)
    }
  })
})

describe("rateLimitRequest", () => {
  it("returns headers and no blocked response for allowed requests", async () => {
    const request = new Request("http://localhost/api/test", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    })

    const result = await rateLimitRequest(request, { maxRequests: 100, windowMs: 60_000 })

    expect(result.blocked).toBeUndefined()
    expect(result.headers["X-RateLimit-Limit"]).toBe("100")
    expect(result.headers["X-RateLimit-Remaining"]).toBeTruthy()
  })

  it("returns a 429 response when rate limit is exceeded", async () => {
    const config = { maxRequests: 2, windowMs: 60_000 }
    const key = "test-429-response"

    for (let i = 0; i < 2; i++) {
      await rateLimitRequest(new Request("http://localhost"), config, key)
    }

    const result = await rateLimitRequest(new Request("http://localhost"), config, key)

    expect(result.blocked).toBeTruthy()
    expect(result.blocked!.status).toBe(429)
    expect(result.blocked!.headers.get("Retry-After")).toBeTruthy()
    expect(result.blocked!.headers.get("Content-Type")).toBe("application/json")
  })

  it("skips rate limiting when MEETSUM_RATE_LIMIT=false", async () => {
    const original = process.env.MEETSUM_RATE_LIMIT
    process.env.MEETSUM_RATE_LIMIT = "false"

    const result = await rateLimitRequest(
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
  it("uses the rightmost (trusted-proxy) IP from x-forwarded-for", async () => {
    // The proxy appends the real peer IP on the right; leftmost entries are
    // client-supplied and spoofable, so the rightmost is the trustworthy key.
    const request = new Request("http://localhost", {
      headers: { "x-forwarded-for": "192.168.1.1, 10.0.0.1" },
    })

    const key = extractRateLimitKey(request)

    expect(key).toBe("10.0.0.1")
  })

  it("falls back to x-real-ip when no forwarded-for is present", async () => {
    const request = new Request("http://localhost", {
      headers: { "x-real-ip": "203.0.113.9" },
    })

    expect(extractRateLimitKey(request)).toBe("203.0.113.9")
  })

  it("appends suffix when provided", async () => {
    const request = new Request("http://localhost", {
      headers: { "x-forwarded-for": "10.0.0.5" },
    })

    const key = extractRateLimitKey(request, "ask")

    expect(key).toBe("10.0.0.5:ask")
  })

  it("falls back to 'unknown' when no forwarded header", async () => {
    const request = new Request("http://localhost")

    const key = extractRateLimitKey(request)

    expect(key).toBe("unknown")
  })
})

describe("getClientIp", () => {
  function testEnv(vars: Record<string, string> = {}) {
    return { NODE_ENV: "test", ...vars } as NodeJS.ProcessEnv
  }

  function request(headers: Record<string, string>) {
    return new Request("http://localhost", { headers })
  }

  it("takes the entry appended by the single trusted proxy by default", async () => {
    expect(
      getClientIp(request({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" }), testEnv())
    ).toBe("198.51.100.7")
  })

  it("honours MEETSUM_TRUSTED_PROXY_HOPS", async () => {
    const env = testEnv({ MEETSUM_TRUSTED_PROXY_HOPS: "2" })
    // client -> CDN (appends client) -> Traefik (appends CDN) -> app
    expect(
      getClientIp(
        request({ "x-forwarded-for": "6.6.6.6, 203.0.113.50, 10.0.0.2" }),
        env
      )
    ).toBe("203.0.113.50")
  })

  it("ignores spoofed left-most entries", async () => {
    const spoofed = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((fake) =>
      getClientIp(request({ "x-forwarded-for": `${fake}, 198.51.100.7` }), testEnv())
    )
    expect(new Set(spoofed)).toEqual(new Set(["198.51.100.7"]))
  })

  it("falls back to x-real-ip when the chain is shorter than the hop count", async () => {
    const env = testEnv({ MEETSUM_TRUSTED_PROXY_HOPS: "3" })
    expect(
      getClientIp(
        request({ "x-forwarded-for": "198.51.100.7", "x-real-ip": "203.0.113.9" }),
        env
      )
    ).toBe("203.0.113.9")
  })

  it("uses MEETSUM_CLIENT_IP_HEADER when set and valid", async () => {
    const env = testEnv({ MEETSUM_CLIENT_IP_HEADER: "cf-connecting-ip" })
    expect(
      getClientIp(
        request({
          "cf-connecting-ip": "2001:4860:4860::8888",
          "x-forwarded-for": "198.51.100.7",
        }),
        env
      )
    ).toBe("2001:4860:4860::8888")
    expect(
      getClientIp(
        request({ "cf-connecting-ip": "garbage", "x-forwarded-for": "198.51.100.7" }),
        env
      )
    ).toBe("198.51.100.7")
  })

  it("rejects invalid addresses instead of using them as keys", async () => {
    expect(getClientIp(request({ "x-forwarded-for": "not-an-ip" }), testEnv())).toBe(
      "unknown"
    )
    expect(
      getClientIp(request({ "x-forwarded-for": "1.2.3.4, <script>" }), testEnv())
    ).toBe("unknown")
    expect(getClientIp(request({ "x-real-ip": "999.1.1.1" }), testEnv())).toBe("unknown")
  })

  it("normalizes ports and brackets", async () => {
    expect(getClientIp(request({ "x-forwarded-for": "198.51.100.7:51234" }), testEnv())).toBe(
      "198.51.100.7"
    )
    expect(getClientIp(request({ "x-forwarded-for": "[2001:db8::1]:443" }), testEnv())).toBe(
      "2001:db8::1"
    )
  })

  it("treats an invalid hop count as 1", async () => {
    const env = testEnv({ MEETSUM_TRUSTED_PROXY_HOPS: "zero" })
    expect(
      getClientIp(request({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" }), env)
    ).toBe("198.51.100.7")
  })
})
