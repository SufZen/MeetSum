import { isIP } from "node:net"

/**
 * In-memory sliding window rate limiter.
 * Suitable for single-instance deployments.
 * For multi-instance, swap for Redis-based limiter.
 */

type RateLimitEntry = {
  timestamps: number[]
}

/** The limiter's backing store (a Map in-process; swappable for tests). */
export type RateLimitStore = Pick<
  Map<string, RateLimitEntry>,
  "get" | "set" | "delete" | "clear" | typeof Symbol.iterator
>

const defaultStore = new Map<string, RateLimitEntry>()
let store: RateLimitStore = defaultStore

/** Tests: replace the store (e.g. one that throws); undefined restores it. */
export function setRateLimitStoreForTesting(next: RateLimitStore | undefined) {
  store = next ?? defaultStore
}

/** A store failure denies the request (fail closed), never allows it. */
function denied(config: RateLimitConfig): RateLimitResult {
  return { allowed: false, remaining: 0, resetMs: Date.now() + Math.min(config.windowMs, 60_000), limit: config.maxRequests }
}

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
  try {
    return checkRateLimitInStore(key, config)
  } catch {
    return denied(config)
  }
}

function checkRateLimitInStore(key: string, config: RateLimitConfig): RateLimitResult {
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
 * Several sliding windows on one key (e.g. 3/min and 20/hour): a request is
 * recorded only when every window allows it; a blocked request is not
 * counted. `resetMs` is when the blocking window frees a slot (or, when
 * allowed, when the tightest window resets).
 */
export function checkRateLimitWindows(
  key: string,
  windows: readonly RateLimitConfig[]
): RateLimitResult {
  try {
    return checkRateLimitWindowsInStore(key, windows)
  } catch {
    return denied(windows[0] ?? { maxRequests: 0, windowMs: 60_000 })
  }
}

function checkRateLimitWindowsInStore(key: string, windows: readonly RateLimitConfig[]): RateLimitResult {
  const longest = Math.max(...windows.map((window) => window.windowMs))

  cleanup(longest)

  const now = Date.now()
  const entry = store.get(key) ?? { timestamps: [] }

  entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > now - longest)
  store.set(key, entry)

  let tightest: RateLimitResult | undefined

  for (const window of windows) {
    const inWindow = entry.timestamps.filter((timestamp) => timestamp > now - window.windowMs)

    if (inWindow.length >= window.maxRequests) {
      const blocked: RateLimitResult = {
        allowed: false,
        remaining: 0,
        resetMs: inWindow[inWindow.length - window.maxRequests] + window.windowMs,
        limit: window.maxRequests,
      }

      if (!tightest || tightest.allowed || blocked.resetMs > tightest.resetMs) tightest = blocked
      continue
    }

    const remaining = window.maxRequests - inWindow.length - 1

    if (!tightest || (tightest.allowed && remaining < tightest.remaining)) {
      tightest = {
        allowed: true,
        remaining,
        resetMs: (inWindow[0] ?? now) + window.windowMs,
        limit: window.maxRequests,
      }
    }
  }

  if (tightest?.allowed) entry.timestamps.push(now)

  return tightest ?? { allowed: true, remaining: 0, resetMs: now, limit: 0 }
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

  /** M6 search (GET /api/search and the compat search routes): 60 per minute */
  search: { maxRequests: 60, windowMs: 60_000 } satisfies RateLimitConfig,

  /** M6 AskMeetSum (POST /api/ask and the compat ask routes): 20 per minute */
  ask: { maxRequests: 20, windowMs: 60_000 } satisfies RateLimitConfig,

  /** M6 Ask thread creation (POST /api/ask/threads), per user: 30 per minute */
  threads: { maxRequests: 30, windowMs: 60_000 } satisfies RateLimitConfig,

  /**
   * On-demand LLM generation (M5 prep briefs and follow-up emails share one
   * budget per `${workspaceId}:${userId|apiKeyId}`): writers 3/min and
   * 20/hour, everyone else 2/min and 10/hour. Use `checkRateLimitWindows`.
   *
   * Like every limit in this module it is in-memory and per instance (there
   * is no Redis backend here): with N web instances the effective budget is
   * up to N times these numbers.
   */
  llmOnDemand: {
    writer: [
      { maxRequests: 3, windowMs: 60_000 },
      { maxRequests: 20, windowMs: 3_600_000 },
    ] satisfies RateLimitConfig[],
    nonWriter: [
      { maxRequests: 2, windowMs: 60_000 },
      { maxRequests: 10, windowMs: 3_600_000 },
    ] satisfies RateLimitConfig[],
  },
} as const

/** The `llmOnDemand` windows for a caller with or without `meeting:write`. */
export function llmOnDemandWindows(canWrite: boolean): readonly RateLimitConfig[] {
  return canWrite ? RATE_LIMIT_PRESETS.llmOnDemand.writer : RATE_LIMIT_PRESETS.llmOnDemand.nonWriter
}

/** Test hook: forgets every recorded request. */
export function resetRateLimitsForTesting() {
  store.clear()
}

function trustedProxyHops(env: NodeJS.ProcessEnv) {
  const parsed = Number(env.MEETSUM_TRUSTED_PROXY_HOPS)

  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
}

/** Strips brackets and an IPv4 `:port` suffix, then returns the IP or undefined. */
function validIp(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  let candidate = value.trim()

  if (candidate.startsWith("[")) {
    const end = candidate.indexOf("]")
    candidate = end > 0 ? candidate.slice(1, end) : candidate
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(":"))
  }

  return isIP(candidate) ? candidate.toLowerCase() : undefined
}

/**
 * Resolves the client IP used as the rate-limit key.
 *
 * - `MEETSUM_CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`), when set and valid,
 *   wins: use it only when the edge proxy overwrites that header.
 * - Otherwise X-Forwarded-For is read from the right: each trusted proxy
 *   appends the address it received the request from, so with
 *   `MEETSUM_TRUSTED_PROXY_HOPS` = N (default 1, Traefik) the client is
 *   entry `len - N`. Entries further left are client-supplied and spoofable.
 * - Then X-Real-IP. Every candidate must parse as an IP (`net.isIP`);
 *   otherwise the key is "unknown".
 */
export function getClientIp(
  request: Request,
  env: NodeJS.ProcessEnv = process.env
): string {
  const headerName = env.MEETSUM_CLIENT_IP_HEADER?.trim()

  if (headerName) {
    const fromHeader = validIp(request.headers.get(headerName))
    if (fromHeader) return fromHeader
  }

  const forwarded = request.headers.get("x-forwarded-for")
  const parts =
    forwarded?.split(",").map((part) => part.trim()).filter(Boolean) ?? []
  const hops = trustedProxyHops(env)

  if (parts.length >= hops) {
    const fromForwarded = validIp(parts[parts.length - hops])
    if (fromForwarded) return fromForwarded
  }

  return validIp(request.headers.get("x-real-ip")) ?? "unknown"
}

/**
 * Extract a rate limit key from a Request (client IP, see `getClientIp`).
 */
export function extractRateLimitKey(request: Request, suffix?: string): string {
  const ip = getClientIp(request)
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
