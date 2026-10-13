/**
 * Per-share-token password failure throttle (M9 follow-up, security review).
 *
 * Global per token, across every IP, and never a lock:
 * - the first `freeFailures` (10) failures in the rolling `windowMs` (1 h)
 *   are unthrottled (the per-IP limit still applies);
 * - from then on attempts on the token are spaced: 2 s after the 10th
 *   failure, doubling with every further failure, capped at 30 s. An attempt
 *   that comes too early gets 429 + Retry-After; it does not count as a
 *   failure and does not extend the wait;
 * - a successful verify clears the token's state.
 * Brute force on one link is held to about one guess per 30 s (~2,880 a
 * day), while the rightful recipient waits at most 30 s. When failures in
 * the window reach `notifyAt` (50), `fail()` reports it once so the caller
 * can notify the meeting owner.
 *
 * In-process state (like lib/rate-limit), bounded to `maxTokens` entries.
 */
export const SHARE_VERIFY_THROTTLE = {
  windowMs: 60 * 60_000,
  freeFailures: 10,
  baseSpacingMs: 2_000,
  maxSpacingMs: 30_000,
  notifyAt: 50,
  maxTokens: 10_000,
} as const

type TokenState = { failures: number[]; lastAttemptAt: number; notified: boolean }

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterMs: number }

export type ShareVerifyThrottle = {
  /** Checks the spacing and, when allowed, reserves this attempt's slot. */
  begin: (token: string) => ThrottleDecision
  /** Records a failed attempt; `notifyOwner` is true exactly once per window streak. */
  fail: (token: string) => { failures: number; notifyOwner: boolean }
  /** A correct password: forget the token's failures. */
  succeed: (token: string) => void
  reset: () => void
}

/** Minimum spacing after `failures` failures in the window (0 below the free allowance). */
export function shareVerifySpacingMs(failures: number, config = SHARE_VERIFY_THROTTLE): number {
  if (failures < config.freeFailures) return 0

  return Math.min(config.maxSpacingMs, config.baseSpacingMs * 2 ** (failures - config.freeFailures))
}

export function createShareVerifyThrottle(
  now: () => number = () => Date.now(),
  config: typeof SHARE_VERIFY_THROTTLE = SHARE_VERIFY_THROTTLE
): ShareVerifyThrottle {
  const states = new Map<string, TokenState>()

  const current = (token: string): TokenState | undefined => {
    const state = states.get(token)

    if (!state) return undefined

    const cutoff = now() - config.windowMs

    state.failures = state.failures.filter((at) => at > cutoff)
    if (!state.failures.length && state.lastAttemptAt <= cutoff) {
      states.delete(token)
      return undefined
    }

    return state
  }

  const ensure = (token: string): TokenState => {
    const existing = current(token)

    if (existing) {
      // Most recently used last, so eviction drops the stalest token.
      states.delete(token)
      states.set(token, existing)
      return existing
    }

    const created: TokenState = { failures: [], lastAttemptAt: 0, notified: false }

    states.set(token, created)
    while (states.size > config.maxTokens) states.delete(states.keys().next().value as string)

    return created
  }

  return {
    begin(token) {
      const state = current(token)
      const spacing = state ? shareVerifySpacingMs(state.failures.length, config) : 0
      const at = now()

      if (state && spacing > 0) {
        const nextAt = state.lastAttemptAt + spacing

        if (at < nextAt) return { allowed: false, retryAfterMs: nextAt - at }
      }

      ensure(token).lastAttemptAt = at

      return { allowed: true }
    },
    fail(token) {
      const state = ensure(token)

      state.failures.push(now())

      const notifyOwner = !state.notified && state.failures.length >= config.notifyAt

      if (notifyOwner) state.notified = true

      return { failures: state.failures.length, notifyOwner }
    },
    succeed(token) {
      states.delete(token)
    },
    reset() {
      states.clear()
    },
  }
}

let shared: ShareVerifyThrottle | undefined

/** The process-wide throttle used by `POST /api/share/[token]/verify`. */
export function getShareVerifyThrottle(): ShareVerifyThrottle {
  shared ??= createShareVerifyThrottle()

  return shared
}
