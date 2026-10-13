/**
 * Integration limits and retry policy (docs/parity/m8.md, A5, A10 and
 * "Env"). Owner: Package A.
 */

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

export function integrationMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.MEETSUM_INTEGRATION_MAX_ATTEMPTS, 5, 20)
}

export function integrationsConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.MEETSUM_INTEGRATIONS_CONCURRENCY, 4, 64)
}

export function deliveryRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.MEETSUM_INTEGRATION_DELIVERY_RETENTION_DAYS, 90, 3650)
}

/** Recipients per recap (hard ceiling 50). */
export function emailRecapMaxRecipients(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.MEETSUM_EMAIL_RECAP_MAX_RECIPIENTS, 50, 50)
}

export function emailRecapMaxPerHour(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.MEETSUM_EMAIL_RECAP_MAX_PER_HOUR, 200, 100_000)
}

export const RETRY_BASE_MS = 30_000
export const RETRY_CAP_MS = 60 * 60_000

/** `Retry-After` when the provider sent one, else exponential from 30 s, capped at 1 h. */
export function deliveryBackoffMs(attemptsMade: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(Math.max(retryAfterMs, 1000), RETRY_CAP_MS)
  }

  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attemptsMade - 1), RETRY_CAP_MS)
}
