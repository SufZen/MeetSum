import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Short-lived, httpOnly proof that a visitor entered the password for a
 * password-protected share link. Replaces passing the password in `?p=`.
 *
 * The cookie value is `<expiresAtMs>.<hmac>` where the HMAC (keyed with the
 * session secret, domain-separated) covers the share token, the share's
 * current password hash and the expiry, so changing or removing the password
 * invalidates outstanding cookies.
 */
export const SHARE_ACCESS_COOKIE = "meetsum_share_access"
export const SHARE_ACCESS_MAX_AGE_SECONDS = 60 * 60 * 12

function signShareAccess(
  token: string,
  passwordHash: string,
  expiresAt: number,
  secret: string
) {
  return createHmac("sha256", secret)
    .update(`share-access:v1:${token}:${passwordHash}:${expiresAt}`)
    .digest("base64url")
}

export function getShareAccessCookiePath(token: string) {
  return `/share/${encodeURIComponent(token)}`
}

export function createShareAccessCookie(options: {
  token: string
  passwordHash: string
  secret: string
  now?: number
  maxAgeSeconds?: number
}): { name: string; value: string; maxAge: number; path: string } {
  const maxAge = options.maxAgeSeconds ?? SHARE_ACCESS_MAX_AGE_SECONDS
  const expiresAt = (options.now ?? Date.now()) + maxAge * 1000
  const signature = signShareAccess(
    options.token,
    options.passwordHash,
    expiresAt,
    options.secret
  )

  return {
    name: SHARE_ACCESS_COOKIE,
    value: `${expiresAt}.${signature}`,
    maxAge,
    path: getShareAccessCookiePath(options.token),
  }
}

export function verifyShareAccessCookie(
  value: string | undefined,
  options: {
    token: string
    passwordHash: string
    secret: string
    now?: number
  }
): boolean {
  if (!value) return false

  const separator = value.indexOf(".")

  if (separator <= 0) return false

  const expiresAtRaw = value.slice(0, separator)
  const signature = value.slice(separator + 1)

  if (!/^\d+$/.test(expiresAtRaw) || !signature) return false

  const expiresAt = Number(expiresAtRaw)

  if (expiresAt <= (options.now ?? Date.now())) return false

  const expected = Buffer.from(
    signShareAccess(options.token, options.passwordHash, expiresAt, options.secret)
  )
  const actual = Buffer.from(signature)

  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
