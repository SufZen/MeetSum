/** Refresh tokens this long before their reported expiry. */
const EXPIRY_SKEW_MS = 60_000

export type CachedToken = { token: string; expiresInSeconds?: number }

/**
 * Caches an OAuth client-credentials token until shortly before it expires
 * and de-duplicates concurrent refreshes.
 */
export function createTokenCache(
  fetchToken: () => Promise<CachedToken>,
  now: () => number = Date.now
) {
  let cached: { token: string; expiresAt: number } | undefined
  let inflight: Promise<string> | undefined

  return {
    async get(): Promise<string> {
      if (cached && cached.expiresAt > now()) return cached.token

      inflight ??= fetchToken()
        .then(({ token, expiresInSeconds }) => {
          const lifetimeMs = (expiresInSeconds ?? 3600) * 1000

          cached = {
            token,
            expiresAt: now() + Math.max(0, lifetimeMs - EXPIRY_SKEW_MS),
          }

          return token
        })
        .finally(() => {
          inflight = undefined
        })

      return inflight
    },
    clear() {
      cached = undefined
    },
  }
}
