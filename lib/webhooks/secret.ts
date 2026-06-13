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
