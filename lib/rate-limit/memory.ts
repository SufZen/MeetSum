/**
 * The per-instance, in-memory sliding-window limiter (the pre-M10 limiter,
 * unchanged). It is the backend when `MEETSUM_RATE_LIMIT_BACKEND=memory` or
 * REDIS_URL is unset, and the fallback for presets that don't fail closed
 * when Redis is down.
 */
import type { RateLimitConfig, RateLimitResult } from "@/lib/rate-limit/types"

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
export function setMemoryStoreForTesting(next: RateLimitStore | undefined) {
  store = next ?? defaultStore
}

export function clearMemoryStore() {
  store.clear()
}

/** A store failure denies the request (fail closed), never allows it. */
export function denied(config: RateLimitConfig): RateLimitResult {
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

export function checkMemoryRateLimit(key: string, config: RateLimitConfig): RateLimitResult {
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

export function checkMemoryRateLimitWindows(key: string, windows: readonly RateLimitConfig[]): RateLimitResult {
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
