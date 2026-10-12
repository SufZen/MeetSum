import { randomBytes } from "node:crypto"

import { decryptSecret, encryptSecret } from "@/lib/auth/secret-crypto"

/**
 * Resolves the webhook signing secret. Throws when unset so we never sign
 * outgoing webhooks with a guessable hardcoded default (the old "dev-secret").
 */
export function getWebhookSigningSecret(
  env: NodeJS.ProcessEnv = process.env
): string {
  const secret = env.WEBHOOK_SIGNING_SECRET

  if (!secret) {
    throw new Error(
      "WEBHOOK_SIGNING_SECRET is required to sign webhook deliveries"
    )
  }

  return secret
}

/** Timeout (ms) for outgoing webhook delivery fetches. */
export function getWebhookFetchTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const parsed = Number(env.MEETSUM_WEBHOOK_TIMEOUT_MS)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000
}

/** Minimum length for an operator-supplied per-subscription signing secret. */
export const MIN_WEBHOOK_SECRET_LENGTH = 16

/** Generates a new per-subscription signing secret (`whsec_…`). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`
}

/** Encrypts a per-subscription secret for `webhook_subscriptions.secret_ciphertext`. */
export function encryptWebhookSecret(secret: string): string {
  return encryptSecret(secret)
}

/**
 * Resolves the secret used to sign deliveries for a subscription: its own
 * encrypted secret when present, otherwise the global secret (legacy rows
 * created before per-subscription secrets existed).
 */
export function resolveSubscriptionSecret(
  subscription: { secret_ciphertext?: string | null },
  env: NodeJS.ProcessEnv = process.env
): string {
  if (subscription.secret_ciphertext) {
    return decryptSecret(subscription.secret_ciphertext)
  }

  return getWebhookSigningSecret(env)
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Total delivery attempts per webhook (first try + retries). */
export function getWebhookMaxAttempts(
  env: NodeJS.ProcessEnv = process.env
): number {
  return positiveInteger(env.MEETSUM_WEBHOOK_MAX_ATTEMPTS, 6)
}

/** Base delay (ms) for exponential webhook retry backoff. */
export function getWebhookBackoffMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return positiveInteger(env.MEETSUM_WEBHOOK_BACKOFF_MS, 30_000)
}
