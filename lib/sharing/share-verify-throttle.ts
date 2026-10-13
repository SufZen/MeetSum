/**
 * Per-share-token password failure throttle (M9 follow-up, security review).
 *
 * The state lives on the share row itself (`meeting_shares.verify_failures`,
 * `verify_window_started_at`, `verify_next_allowed_at`, migration 031), so it
 * is shared by every app instance, cannot be evicted by flooding other
 * tokens, and only ever exists for real shares: an unknown token creates no
 * state (the route answers the same 404). The memory backend mirrors it per
 * in-memory database. Each step is one atomic `update … where token = $1`.
 *
 * Schedule, global per token across every IP:
 * - the first `freeFailures` (10) failures of a streak are unthrottled (the
 *   per-IP limit, 10/min, still applies). A streak ends only after
 *   `windowMs` (1 h) without a failure, so a sustained attack never gets a
 *   fresh free allowance (`verify_window_started_at` is the streak start);
 * - then attempts are spaced 2 s, doubling with every further failure,
 *   capped at 30 s. An early attempt gets 429 + Retry-After and is not
 *   counted as a failure;
 * - a successful verify clears the state;
 * - the request whose failure is the `notifyAt`-th (50) of the streak
 *   notifies the meeting owner (exactly one request sees that count; failures
 *   at least once an hour keep a streak going).
 *
 * ACCEPTED TRADEOFF (security review, documented in docs/parity/m9.md
 * "Security notes"): brute-force resistance vs a bounded delay. Anyone who
 * knows the link can make the rightful recipient wait up to 30 s per
 * attempt, but never longer: there is no permanent lock, a success resets
 * the counter, a valid share-access cookie skips verification entirely and
 * the owner is told at 50 failures. In exchange an attacker gets about one
 * guess per 30 s per link (~2,880 a day) however many IPs they use. Do not
 * tighten the schedule without revisiting that decision.
 */
import type { Queryable } from "@/lib/db/client"
import type { InMemoryMeetingDatabase } from "@/lib/meetings/repository"

export const SHARE_VERIFY_THROTTLE = {
  windowMs: 60 * 60_000,
  freeFailures: 10,
  baseSpacingMs: 2_000,
  maxSpacingMs: 30_000,
  notifyAt: 50,
} as const

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterMs: number }

export type ShareVerifyThrottle = {
  /**
   * Checks the spacing and, when allowed, reserves this attempt's slot.
   * `undefined`: no share has this token (nothing is created).
   */
  begin: (token: string, now?: number) => Promise<ThrottleDecision | undefined>
  /** Records a failed attempt; `notifyOwner` is true for exactly the `notifyAt`-th failure of the window. */
  fail: (token: string, now?: number) => Promise<{ failures: number; notifyOwner: boolean } | undefined>
  /** A correct password: clear the token's state. */
  succeed: (token: string) => Promise<void>
}

/** Minimum spacing after `failures` failures in the window (0 below the free allowance). */
export function shareVerifySpacingMs(failures: number, config = SHARE_VERIFY_THROTTLE): number {
  if (failures < config.freeFailures) return 0

  return Math.min(config.maxSpacingMs, config.baseSpacingMs * 2 ** (failures - config.freeFailures))
}

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

/**
 * Failures still counting at `$2`: the streak ends (counts as 0) only after
 * `$6` ms without a failure; `verify_next_allowed_at` is set at every failure.
 */
const CURRENT_FAILURES = `(case when s.verify_window_started_at is null
      or coalesce(s.verify_next_allowed_at, s.verify_window_started_at)
         <= $2::timestamptz - ($6::double precision * interval '1 millisecond')
    then 0 else s.verify_failures end)`

/** Spacing in ms after `f` failures: 0 below $3, else least($5, $4 · 2^(f − $3)). */
const spacingSql = (f: string) =>
  `(case when ${f} < $3 then 0 else least($5::double precision, $4::double precision * power(2, ${f} - $3)) end)`

const ms = (expression: string) => `(${expression} * interval '1 millisecond')`

export function createPostgresShareVerifyThrottle(
  client: Queryable,
  config: typeof SHARE_VERIFY_THROTTLE = SHARE_VERIFY_THROTTLE
): ShareVerifyThrottle {
  const params = (token: string, now: number) => [
    token,
    new Date(now).toISOString(),
    config.freeFailures,
    config.baseSpacingMs,
    config.maxSpacingMs,
    config.windowMs,
  ]

  return {
    async begin(token, now = Date.now()) {
      const claimed = await client.query(
        `update meeting_shares s
            set verify_next_allowed_at = $2::timestamptz + ${ms(spacingSql(CURRENT_FAILURES))}
          where s.token = $1
            and (s.verify_next_allowed_at is null or s.verify_next_allowed_at <= $2::timestamptz)
          returning s.id`,
        params(token, now)
      )

      if (claimed.rows.length) return { allowed: true }

      const row = (
        await client.query(`select verify_next_allowed_at from meeting_shares where token = $1`, [token])
      ).rows[0] as { verify_next_allowed_at: Date | string | null } | undefined

      if (!row) return undefined

      const next = row.verify_next_allowed_at ? new Date(row.verify_next_allowed_at).getTime() : now

      return { allowed: false, retryAfterMs: Math.max(1, next - now) }
    },

    async fail(token, now = Date.now()) {
      const newFailures = `(${CURRENT_FAILURES} + 1)`
      const result = await client.query(
        `update meeting_shares s
            set verify_failures = ${newFailures},
                verify_window_started_at = case when ${CURRENT_FAILURES} = 0 then $2::timestamptz
                                                else s.verify_window_started_at end,
                verify_next_allowed_at = greatest(
                  coalesce(s.verify_next_allowed_at, $2::timestamptz),
                  $2::timestamptz + ${ms(spacingSql(newFailures))}
                )
          where s.token = $1
          returning s.verify_failures`,
        params(token, now)
      )
      const row = result.rows[0] as { verify_failures: number } | undefined

      if (!row) return undefined

      const failures = Number(row.verify_failures)

      return { failures, notifyOwner: failures === config.notifyAt }
    },

    async succeed(token) {
      await client.query(
        `update meeting_shares
            set verify_failures = 0, verify_window_started_at = null, verify_next_allowed_at = null
          where token = $1`,
        [token]
      )
    },
  }
}

/* ------------------------------------------------------------------ */
/* Memory (non-Postgres mode): the same rules, per in-memory database   */
/* ------------------------------------------------------------------ */

type MemoryState = { failures: number; windowStartedAt: number | null; nextAllowedAt: number | null }

const memoryStates = new WeakMap<InMemoryMeetingDatabase, Map<string, MemoryState>>()

export function createInMemoryShareVerifyThrottle(
  db: InMemoryMeetingDatabase,
  config: typeof SHARE_VERIFY_THROTTLE = SHARE_VERIFY_THROTTLE
): ShareVerifyThrottle {
  let states = memoryStates.get(db)

  if (!states) {
    states = new Map()
    memoryStates.set(db, states)
  }

  const table = states
  /** The state of a real share (keyed by share id), or undefined for an unknown token. */
  const stateOf = (token: string): MemoryState | undefined => {
    const share = [...db.shares.values()].find((candidate) => candidate.token === token)

    if (!share) return undefined

    let state = table.get(share.id)

    if (!state) {
      state = { failures: 0, windowStartedAt: null, nextAllowedAt: null }
      table.set(share.id, state)
    }

    return state
  }
  const current = (state: MemoryState, now: number) =>
    state.windowStartedAt === null || (state.nextAllowedAt ?? state.windowStartedAt) <= now - config.windowMs
      ? 0
      : state.failures

  return {
    async begin(token, now = Date.now()) {
      const state = stateOf(token)

      if (!state) return undefined
      if (state.nextAllowedAt !== null && state.nextAllowedAt > now) {
        return { allowed: false, retryAfterMs: Math.max(1, state.nextAllowedAt - now) }
      }

      state.nextAllowedAt = now + shareVerifySpacingMs(current(state, now), config)

      return { allowed: true }
    },

    async fail(token, now = Date.now()) {
      const state = stateOf(token)

      if (!state) return undefined

      const before = current(state, now)
      const failures = before + 1

      if (before === 0) state.windowStartedAt = now
      state.failures = failures
      state.nextAllowedAt = Math.max(state.nextAllowedAt ?? now, now + shareVerifySpacingMs(failures, config))

      return { failures, notifyOwner: failures === config.notifyAt }
    },

    async succeed(token) {
      const state = stateOf(token)

      if (state) Object.assign(state, { failures: 0, windowStartedAt: null, nextAllowedAt: null })
    },
  }
}
