import { envNumber, type AsrEnv } from "./config"
import { isMediaSpecific, redactAsrErrorMessage } from "./errors"
import type { AsrError, AsrProviderId } from "./types"

/**
 * Per-provider circuit breaker. `threshold` consecutive retryable failures
 * open the circuit for `cooldownMs`; auth/config failures open it for an
 * hour (a key problem will not fix itself). bad_input never counts — that
 * is the media's fault, not the provider's. State lives in memory or in
 * Redis (`meetsum:asr:breaker:<id>`) so all workers share it.
 */

export type BreakerState = { failures: number; openUntil?: number; lastError?: string }

export interface BreakerStore {
  get(id: AsrProviderId): Promise<BreakerState | undefined>
  set(id: AsrProviderId, state: BreakerState, ttlMs: number): Promise<void>
  clear(id: AsrProviderId): Promise<void>
}

export class MemoryBreakerStore implements BreakerStore {
  private readonly states = new Map<AsrProviderId, { state: BreakerState; expiresAt: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  async get(id: AsrProviderId) {
    const entry = this.states.get(id)

    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.states.delete(id)
      return undefined
    }
    return { ...entry.state }
  }

  async set(id: AsrProviderId, state: BreakerState, ttlMs: number) {
    this.states.set(id, { state: { ...state }, expiresAt: this.now() + ttlMs })
  }

  async clear(id: AsrProviderId) {
    this.states.delete(id)
  }
}

/** Minimal ioredis-compatible surface used by the Redis store. */
export type BreakerRedisClient = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: "PX", ttl: number): Promise<unknown>
  del(key: string): Promise<unknown>
}

export const BREAKER_KEY_PREFIX = "meetsum:asr:breaker:"

/**
 * Redis-backed store. Any Redis error falls back to the in-process store so
 * a Redis outage never blocks transcription.
 */
export class RedisBreakerStore implements BreakerStore {
  private readonly fallback: MemoryBreakerStore

  constructor(
    private readonly client: () => Promise<BreakerRedisClient>,
    now: () => number = Date.now
  ) {
    this.fallback = new MemoryBreakerStore(now)
  }

  async get(id: AsrProviderId) {
    try {
      const raw = await (await this.client()).get(`${BREAKER_KEY_PREFIX}${id}`)

      return raw ? (JSON.parse(raw) as BreakerState) : undefined
    } catch {
      return this.fallback.get(id)
    }
  }

  async set(id: AsrProviderId, state: BreakerState, ttlMs: number) {
    await this.fallback.set(id, state, ttlMs)

    try {
      await (await this.client()).set(`${BREAKER_KEY_PREFIX}${id}`, JSON.stringify(state), "PX", Math.max(1, Math.round(ttlMs)))
    } catch {
      // Memory fallback already holds the state.
    }
  }

  async clear(id: AsrProviderId) {
    await this.fallback.clear(id)

    try {
      await (await this.client()).del(`${BREAKER_KEY_PREFIX}${id}`)
    } catch {
      // ignore
    }
  }
}

export type BreakerOptions = {
  store?: BreakerStore
  threshold?: number
  cooldownMs?: number
  authCooldownMs?: number
  now?: () => number
}

export type CircuitBreaker = {
  status(id: AsrProviderId): Promise<{ open: boolean; openUntil?: number; failures: number; lastError?: string }>
  recordSuccess(id: AsrProviderId): Promise<void>
  recordFailure(id: AsrProviderId, error: AsrError): Promise<void>
}

const AUTH_COOLDOWN_MS = 3_600_000

export function createCircuitBreaker(options: BreakerOptions = {}): CircuitBreaker {
  const now = options.now ?? Date.now
  const store = options.store ?? new MemoryBreakerStore(now)
  const threshold = Math.max(1, options.threshold ?? 3)
  const cooldownMs = options.cooldownMs ?? 600_000
  const authCooldownMs = options.authCooldownMs ?? AUTH_COOLDOWN_MS
  // Failure counters outlive a cooldown window by a day at most.
  const counterTtlMs = Math.max(cooldownMs, authCooldownMs) * 24

  return {
    async status(id) {
      const state = await store.get(id)
      const open = Boolean(state?.openUntil && state.openUntil > now())

      return {
        open,
        openUntil: open ? state?.openUntil : undefined,
        failures: state?.failures ?? 0,
        lastError: state?.lastError,
      }
    },

    async recordSuccess(id) {
      await store.clear(id)
    },

    async recordFailure(id, error) {
      // Identity check first: media-specific flags live on the original error.
      if (isMediaSpecific(error)) return
      // Provider text can echo presigned handoff URLs or keys; the breaker
      // state is persisted (Redis) and surfaced by /api/asr/status.
      const lastError = redactAsrErrorMessage(error.message)

      if (error.kind === "auth" || error.kind === "config") {
        await store.set(id, { failures: 0, openUntil: now() + authCooldownMs, lastError }, authCooldownMs)
        return
      }
      if (!error.retryable) return

      const state = (await store.get(id)) ?? { failures: 0 }
      const failures = (state.openUntil && state.openUntil <= now() ? 0 : state.failures) + 1

      if (failures >= threshold) {
        await store.set(id, { failures: 0, openUntil: now() + cooldownMs, lastError }, cooldownMs)
        return
      }

      await store.set(id, { failures, lastError }, counterTtlMs)
    },
  }
}

export function breakerOptionsFromEnv(env: AsrEnv): Pick<BreakerOptions, "threshold" | "cooldownMs"> {
  return {
    threshold: envNumber(env, "MEETSUM_ASR_BREAKER_THRESHOLD", 3),
    cooldownMs: envNumber(env, "MEETSUM_ASR_BREAKER_COOLDOWN_MS", 600_000),
  }
}
