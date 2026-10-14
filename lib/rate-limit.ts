import { isIP } from "node:net"

import { getLogger } from "@/lib/log"
import {
  checkMemoryRateLimit,
  checkMemoryRateLimitWindows,
  clearMemoryStore,
  denied,
  setMemoryStoreForTesting,
  type RateLimitStore,
} from "@/lib/rate-limit/memory"
import { checkRedisRateLimitWindows, type RateLimitRedis } from "@/lib/rate-limit/redis"
import { getAppRedis, redisUrl, withRedisTimeout } from "@/lib/rate-limit/redis-client"
import type { RateLimitConfig, RateLimitResult } from "@/lib/rate-limit/types"

/**
 * Sliding-window rate limiter (M10 R1, docs/parity/m10.md "Rate limiter").
 *
 * - Backend: `MEETSUM_RATE_LIMIT_BACKEND=memory|redis`; default `redis` when
 *   REDIS_URL is set, otherwise `memory` (per instance, the pre-M10 limiter).
 * - Redis: one Lua script over a sorted set per `rl:<preset>:<sha256(key)>`,
 *   on the app's dedicated ioredis connection (lib/rate-limit/redis*.ts).
 * - Redis down or slow (> 500 ms): presets with `failClosed` (share verify,
 *   ask, on-demand LLM, auth, exports, search) deny; every other preset falls
 *   back to the per-instance memory limiter. Logged at most once a minute.
 * - `MEETSUM_RATE_LIMIT=false` disables limiting in `rateLimitRequest` and
 *   `limitLlmOnDemand` (unchanged).
 */
export type { RateLimitConfig, RateLimitResult, RateLimitStore }

const REDIS_TIMEOUT_MS = 500
const FAILURE_LOG_INTERVAL_MS = 60_000

let redisOverride: RateLimitRedis | null | undefined
let lastFailureLogAt = 0

/** Tests: replace the memory store (e.g. one that throws); undefined restores it. */
export function setRateLimitStoreForTesting(next: RateLimitStore | undefined) {
  setMemoryStoreForTesting(next)
}

/**
 * Tests: use `client` as the Redis backend (a fake or a real connection);
 * `null` forces "Redis unavailable"; `undefined` restores the default.
 */
export function setRateLimitRedisForTesting(client: RateLimitRedis | null | undefined) {
  redisOverride = client
}

export type RateLimitBackend = "memory" | "redis"

export function rateLimitBackend(env: NodeJS.ProcessEnv = process.env): RateLimitBackend {
  const configured = env.MEETSUM_RATE_LIMIT_BACKEND?.trim().toLowerCase()

  if (configured === "memory" || configured === "redis") return configured
  if (redisOverride !== undefined) return "redis"
  // Unit tests run on the memory backend unless a test opts into Redis.
  if (env.VITEST) return "memory"

  return redisUrl(env) ? "redis" : "memory"
}

function redisClient(): RateLimitRedis | undefined {
  if (redisOverride !== undefined) return redisOverride ?? undefined

  const client = getAppRedis()

  return client ? (client as unknown as RateLimitRedis) : undefined
}

function noteRedisFailure(policy: RateLimitConfig, error: unknown) {
  const now = Date.now()

  if (now - lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return
  lastFailureLogAt = now
  getLogger({ component: "rate-limit" }).warn(
    { preset: policy.name ?? "custom", failClosed: Boolean(policy.failClosed), errorName: error instanceof Error ? error.name : "error" },
    policy.failClosed
      ? "rate limiter Redis unavailable: failing closed for cost/abuse presets"
      : "rate limiter Redis unavailable: falling back to the per-instance memory limiter"
  )
}

async function checkWithBackend(
  key: string,
  windows: readonly RateLimitConfig[],
  memory: () => RateLimitResult
): Promise<RateLimitResult> {
  const policy = windows[0] ?? { maxRequests: 0, windowMs: 60_000 }

  if (policy.local || rateLimitBackend() === "memory") return memory()

  try {
    const client = redisClient()

    if (!client) throw new Error("Redis is not configured")

    return await withRedisTimeout(checkRedisRateLimitWindows(client, policy.name, key, windows), REDIS_TIMEOUT_MS)
  } catch (error) {
    noteRedisFailure(policy, error)

    return policy.failClosed ? denied(policy) : memory()
  }
}

/**
 * Check if a request from the given key is allowed under the rate limit.
 */
export async function checkRateLimit(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
  return checkWithBackend(key, [config], () => checkMemoryRateLimit(key, config))
}

/**
 * Several sliding windows on one key (e.g. 3/min and 20/hour): a request is
 * recorded only when every window allows it; a blocked request is not
 * counted. `resetMs` is when the blocking window frees a slot (or, when
 * allowed, when the tightest window resets). The first window's `name` and
 * `failClosed` apply to the whole check.
 */
export async function checkRateLimitWindows(
  key: string,
  windows: readonly RateLimitConfig[]
): Promise<RateLimitResult> {
  return checkWithBackend(key, windows, () => checkMemoryRateLimitWindows(key, windows))
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
 * Pre-configured rate limit presets for common use cases. `failClosed`
 * presets guard cost or abuse and deny when Redis is down (M10 R1).
 */
export const RATE_LIMIT_PRESETS = {
  /** General API access: 120 requests per minute */
  api: { name: "api", maxRequests: 120, windowMs: 60_000 } satisfies RateLimitConfig,

  /** AI processing (transcription, summarization): 10 per minute */
  aiProcessing: { name: "aiProcessing", maxRequests: 10, windowMs: 60_000 } satisfies RateLimitConfig,

  /** Export operations: 20 per minute (fails closed: server-side rendering cost) */
  exports: { name: "exports", maxRequests: 20, windowMs: 60_000, failClosed: true } satisfies RateLimitConfig,

  /** Share link creation: 30 per minute */
  share: { name: "share", maxRequests: 30, windowMs: 60_000 } satisfies RateLimitConfig,

  /** Share-link password checks: 10 per minute per IP and token (fails closed: brute force) */
  shareVerify: { name: "share-verify", maxRequests: 10, windowMs: 60_000, failClosed: true } satisfies RateLimitConfig,

  /** Public share page access: 60 per minute per token */
  publicAccess: { name: "publicAccess", maxRequests: 60, windowMs: 60_000 } satisfies RateLimitConfig,

  /**
   * Public health probes (/api/health*): 120 per minute per IP, always the
   * per-instance memory limiter so a probe never depends on Redis.
   */
  health: { name: "health", maxRequests: 120, windowMs: 60_000, local: true } satisfies RateLimitConfig,

  /** Admin operations: 30 per minute */
  admin: { name: "admin", maxRequests: 30, windowMs: 60_000 } satisfies RateLimitConfig,

  /** M6 search (GET /api/search and the compat search routes): 60 per minute (fails closed: query cost) */
  search: { name: "search", maxRequests: 60, windowMs: 60_000, failClosed: true } satisfies RateLimitConfig,

  /** M6 AskMeetSum (POST /api/ask and the compat ask routes): 20 per minute (fails closed: LLM cost) */
  ask: { name: "ask", maxRequests: 20, windowMs: 60_000, failClosed: true } satisfies RateLimitConfig,

  /** M6 Ask thread creation (POST /api/ask/threads), per user: 30 per minute */
  threads: { name: "threads", maxRequests: 30, windowMs: 60_000 } satisfies RateLimitConfig,

  /**
   * M8 OAuth start (GET /api/integrations/[provider]/oauth/start), per user:
   * 10 per minute. This is the "auth" preset of the M10 fail-closed list.
   */
  integrationsOAuth: { name: "auth", maxRequests: 10, windowMs: 60_000, failClosed: true } satisfies RateLimitConfig,

  /** M8 connection, rule and meeting-prefs writes: 30 per minute */
  integrationsWrite: { name: "integrationsWrite", maxRequests: 30, windowMs: 60_000 } satisfies RateLimitConfig,

  /** M8 manual sends (POST /api/meetings/[id]/integrations/send): 10 per minute */
  integrationsSend: { name: "integrationsSend", maxRequests: 10, windowMs: 60_000 } satisfies RateLimitConfig,

  /** M8 webhook test-fire (POST /api/webhooks/test): 10 per minute */
  webhookTest: { name: "webhookTest", maxRequests: 10, windowMs: 60_000 } satisfies RateLimitConfig,

  /**
   * On-demand LLM generation (M5 prep briefs and follow-up emails share one
   * budget per `${workspaceId}:${userId|apiKeyId}`): writers 3/min and
   * 20/hour, everyone else 2/min and 10/hour. Use `checkRateLimitWindows`.
   * Shared across instances on the Redis backend; fails closed (LLM cost).
   */
  llmOnDemand: {
    writer: [
      { name: "llmOnDemand", maxRequests: 3, windowMs: 60_000, failClosed: true },
      { name: "llmOnDemand", maxRequests: 20, windowMs: 3_600_000, failClosed: true },
    ] satisfies RateLimitConfig[],
    nonWriter: [
      { name: "llmOnDemand", maxRequests: 2, windowMs: 60_000, failClosed: true },
      { name: "llmOnDemand", maxRequests: 10, windowMs: 3_600_000, failClosed: true },
    ] satisfies RateLimitConfig[],
  },
} as const

/** The `llmOnDemand` windows for a caller with or without `meeting:write`. */
export function llmOnDemandWindows(canWrite: boolean): readonly RateLimitConfig[] {
  return canWrite ? RATE_LIMIT_PRESETS.llmOnDemand.writer : RATE_LIMIT_PRESETS.llmOnDemand.nonWriter
}

/** Test hook: forgets every recorded request (memory backend) and the log throttle. */
export function resetRateLimitsForTesting() {
  clearMemoryStore()
  lastFailureLogAt = 0
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
export async function rateLimitRequest(
  request: Request,
  config: RateLimitConfig,
  keyOverride?: string
): Promise<{ blocked?: Response; headers: Record<string, string> }> {
  if (process.env.MEETSUM_RATE_LIMIT === "false") {
    return { headers: {} }
  }

  const key = keyOverride ?? extractRateLimitKey(request)
  const result = await checkRateLimit(key, config)

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
