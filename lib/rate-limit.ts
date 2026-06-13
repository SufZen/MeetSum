/**
 * In-memory sliding window rate limiter.
 * Suitable for single-instance deployments.
 * For multi-instance, swap for Redis-based limiter.
 */

type RateLimitEntry = {
  timestamps: number[]
}

const store = new Map<string, RateLimitEntry>()

// Clean up stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

let lastCleanup = Date.now()

function cleanup(windowMs: number) {
  const now = Date.now()

  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return

  lastCleanup = now
  const cutoff = now - windowMs * 2

  for (const [key, entry] of store) {
    if (entry.timestamps.length === 0 || entry.timestamps[entry.timestamps.length - 1] < cutoff) {
      store.delete(key)
    }
  }
}

export type RateLimitConfig = {
  /** Maximum requests allowed within the window */
  maxRequests: number
  /** Window size in milliseconds */
  windowMs: number
}

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetMs: number
  limit: number
}

/**
 * Check if a request from the given key is allowed under the rate limit.
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  cleanup(config.windowMs)

  const now = Date.now()
  const cutoff = now - config.windowMs
  const entry = store.get(key)

  if (!entry) {
    store.set(key, { timestamps: [now] })

    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetMs: now + config.windowMs,
      limit: config.maxRequests,
    }
  }

  // Remove expired timestamps
  entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff)

  if (entry.timestamps.length >= config.maxRequests) {
    const oldestInWindow = entry.timestamps[0]

    return {
      allowed: false,
      remaining: 0,
      resetMs: oldestInWindow + config.windowMs,
      limit: config.maxRequests,
    }
  }

  entry.timestamps.push(now)

  return {
    allowed: true,
    remaining: config.maxRequests - entry.timestamps.length,
    resetMs: entry.timestamps[0] + config.windowMs,
    limit: config.maxRequests,
  }
}

/**
 * Apply rate limit headers to a Response.
 */
export function applyRateLimitHeaders(
  headers: Headers,
  result: RateLimitResult
) {
  headers.set("X-RateLimit-Limit", String(result.limit))
  headers.set("X-RateLimit-Remaining", String(result.remaining))
  headers.set("X-RateLimit-Reset", String(Math.ceil(result.resetMs / 1000)))
}

/**
 * Pre-configured rate limit presets for common use cases.
 */
export const RATE_LIMIT_PRESETS = {
  /** General API access: 120 requests per minute */
  api: { maxRequests: 120, windowMs: 60_000 } satisfies RateLimitConfig,

  /** AI processing (transcription, summarization): 10 per minute */
  aiProcessing: { maxRequests: 10, windowMs: 60_000 } satisfies RateLimitConfig,

  /** Export operations: 20 per minute */
  exports: { maxRequests: 20, windowMs: 60_000 } satisfies RateLimitConfig,

  /** Share link creation: 30 per minute */
  share: { maxRequests: 30, windowMs: 60_000 } satisfies RateLimitConfig,

  /** Public share page access: 60 per minute per token */
  publicAccess: { maxRequests: 60, windowMs: 60_000 } satisfies RateLimitConfig,

  /** Admin operations: 30 per minute */
  admin: { maxRequests: 30, windowMs: 60_000 } satisfies RateLimitConfig,
} as const

/**
 * Extract a rate limit key from a Request.
 * Uses X-Forwarded-For (reverse proxy) or falls back to a static key.
 */
export function extractRateLimitKey(request: Request, suffix?: string): string {
  // Use the RIGHTMOST X-Forwarded-For entry — the one appended by our trusted
  // reverse proxy (Traefik/Coolify). Leftmost entries are client-supplied and
  // can be spoofed to mint a fresh rate-limit bucket on every request.
  const forwarded = request.headers.get("x-forwarded-for")
  const parts =
    forwarded?.split(",").map((part) => part.trim()).filter(Boolean) ?? []
  const ip =
    parts.length > 0
      ? parts[parts.length - 1]!
      : request.headers.get("x-real-ip")?.trim() || "unknown"
  return suffix ? `${ip}:${suffix}` : ip
}

/**
 * Check rate limit for a request. Returns a 429 Response if blocked, or undefined if allowed.
 * Also applies X-RateLimit-* headers to the provided headers object.
 */
export function rateLimitRequest(
  request: Request,
  config: RateLimitConfig,
  keyOverride?: string
): { blocked?: Response; headers: Record<string, string> } {
  if (process.env.MEETSUM_RATE_LIMIT === "false") {
    return { headers: {} }
  }

  const key = keyOverride ?? extractRateLimitKey(request)
  const result = checkRateLimit(key, config)

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetMs / 1000)),
  }

  if (!result.allowed) {
    const retryAfter = Math.ceil((result.resetMs - Date.now()) / 1000)

    return {
      blocked: new Response(
        JSON.stringify({ error: "Too many requests" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(Math.max(1, retryAfter)),
            ...headers,
          },
        }
      ),
      headers,
    }
  }

  return { headers }
}
