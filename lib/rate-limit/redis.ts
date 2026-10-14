/**
 * Redis sliding-window limiter (docs/parity/m10.md, "Rate limiter (R1)").
 *
 * One Lua script per check over a sorted set of request timestamps:
 * ZREMRANGEBYSCORE (drop entries older than the longest window), ZCOUNT per
 * window, ZADD (only when every window allows), PEXPIRE (longest window).
 * Several windows on one key (3/min + 20/hour) are checked atomically.
 *
 * Keys are `rl:<preset>:<sha256(key)>`: raw IPs and user ids never reach
 * Redis. The result is computed exactly like the memory limiter's
 * multi-window check, so both backends agree on `remaining` and `resetMs`.
 */
import { createHash, randomBytes } from "node:crypto"

import type { RateLimitConfig, RateLimitResult } from "@/lib/rate-limit/types"

/**
 * The minimal client surface used here: Redis EVAL (server-side Lua), only
 * ever called with the constant SLIDING_WINDOW_LUA below. Nothing is
 * evaluated in this process and no input becomes code.
 */
export type RateLimitRedis = {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

/**
 * KEYS[1] = the sorted set; ARGV = now, member, then (windowMs, max) pairs.
 * Returns { allowed, count1, anchor1, count2, anchor2, ... } where anchor is
 * the score of the entry that frees a slot (blocked) or the oldest entry in
 * the window (allowed; `now` when the window is empty).
 */
export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local member = ARGV[2]
local n = (#ARGV - 2) / 2
local longest = 0
for i = 1, n do
  local w = tonumber(ARGV[1 + i * 2])
  if w > longest then longest = w end
end
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - longest)
local out = {}
local allowed = 1
for i = 1, n do
  local w = tonumber(ARGV[1 + i * 2])
  local max = tonumber(ARGV[2 + i * 2])
  local min = '(' .. (now - w)
  local count = redis.call('ZCOUNT', key, min, '+inf')
  local anchor = now
  if count >= max then
    allowed = 0
    local r = redis.call('ZRANGEBYSCORE', key, min, '+inf', 'WITHSCORES', 'LIMIT', count - max, 1)
    anchor = tonumber(r[2])
  elseif count > 0 then
    local r = redis.call('ZRANGEBYSCORE', key, min, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
    anchor = tonumber(r[2])
  end
  out[#out + 1] = count
  out[#out + 1] = anchor
end
if allowed == 1 then
  redis.call('ZADD', key, now, member)
end
redis.call('PEXPIRE', key, longest)
table.insert(out, 1, allowed)
return out
`

export function redisRateLimitKey(name: string | undefined, key: string): string {
  return `rl:${name ?? "custom"}:${createHash("sha256").update(key).digest("hex")}`
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)

  if (!Number.isFinite(parsed)) throw new Error("rate limit script returned a non-number")
  return parsed
}

/** The memory limiter's multi-window aggregation over per-window counts. */
function combine(
  windows: readonly RateLimitConfig[],
  perWindow: Array<{ count: number; anchor: number }>,
  now: number
): RateLimitResult {
  let tightest: RateLimitResult | undefined

  windows.forEach((window, index) => {
    const { count, anchor } = perWindow[index]

    if (count >= window.maxRequests) {
      const blocked: RateLimitResult = { allowed: false, remaining: 0, resetMs: anchor + window.windowMs, limit: window.maxRequests }

      if (!tightest || tightest.allowed || blocked.resetMs > tightest.resetMs) tightest = blocked
      return
    }

    const remaining = window.maxRequests - count - 1

    if (!tightest || (tightest.allowed && remaining < tightest.remaining)) {
      tightest = { allowed: true, remaining, resetMs: (count > 0 ? anchor : now) + window.windowMs, limit: window.maxRequests }
    }
  })

  return tightest ?? { allowed: true, remaining: 0, resetMs: now, limit: 0 }
}

/** Runs the script; throws on any Redis error (the caller applies the fail policy). */
export async function checkRedisRateLimitWindows(
  client: RateLimitRedis,
  name: string | undefined,
  key: string,
  windows: readonly RateLimitConfig[],
  now: number = Date.now()
): Promise<RateLimitResult> {
  if (windows.length === 0) return { allowed: true, remaining: 0, resetMs: now, limit: 0 }

  const member = `${now}-${randomBytes(6).toString("hex")}`
  const args = windows.flatMap((window) => [window.windowMs, window.maxRequests])
  const raw = await client.eval(SLIDING_WINDOW_LUA, 1, redisRateLimitKey(name, key), now, member, ...args)

  if (!Array.isArray(raw) || raw.length !== 1 + windows.length * 2) {
    throw new Error("rate limit script returned an unexpected shape")
  }

  const perWindow = windows.map((_window, index) => ({
    count: toNumber(raw[1 + index * 2]),
    anchor: toNumber(raw[2 + index * 2]),
  }))

  return combine(windows, perWindow, now)
}
