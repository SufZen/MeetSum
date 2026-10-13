/**
 * Token custody (docs/parity/m8.md, "Token secrecy" and "Token refresh").
 * Owner: Package A. The ONLY module that decrypts integration tokens.
 *
 * - Tokens are AES-256-GCM `v2` ciphertexts bound to
 *   `${workspaceId}:${connectionId}:${field}` (a ciphertext copied to another
 *   row or field fails to decrypt).
 * - `getAccessToken` refreshes when `expires_at − 120 s < now`, inside the
 *   connection row lock, so concurrent jobs never race a rotating refresh
 *   token; a newly returned refresh token is always persisted.
 * - `invalid_grant` (or any `auth` failure) → `needs_reauth`.
 *
 * Routes never import this module (the route-coverage test checks it).
 */
import { decryptSecret, encryptSecret } from "@/lib/auth/secret-crypto"
import { storedIntegrationError } from "@/lib/integrations/core/errors"
import { markConnectionNeedsReauth, type ReauthDeps } from "@/lib/integrations/core/reauth"
import { getProvider } from "@/lib/integrations/core/registry"
import { getIntegrationStore, type IntegrationStore, type StoredConnection } from "@/lib/integrations/core/store"
import { ProviderError, type IntegrationProvider, type TokenSet } from "@/lib/integrations/core/types"

export type TokenField = "access_token" | "refresh_token"

export const REFRESH_SKEW_MS = 120_000

export function tokenAad(workspaceId: string, connectionId: string, field: TokenField): string {
  return `${workspaceId}:${connectionId}:${field}`
}

export function sealToken(workspaceId: string, connectionId: string, field: TokenField, value: string): string {
  return encryptSecret(value, tokenAad(workspaceId, connectionId, field))
}

export function openToken(connection: Pick<StoredConnection, "workspaceId" | "id" | "accessTokenEnc" | "refreshTokenEnc">, field: TokenField): string | undefined {
  const sealed = field === "access_token" ? connection.accessTokenEnc : connection.refreshTokenEnc

  if (!sealed) return undefined

  return decryptSecret(sealed, tokenAad(connection.workspaceId, connection.id, field))
}

/** Encrypted column values for a TokenSet (refresh token only when present). */
export function sealTokenSet(workspaceId: string, connectionId: string, tokens: TokenSet) {
  return {
    accessTokenEnc: sealToken(workspaceId, connectionId, "access_token", tokens.accessToken),
    ...(tokens.refreshToken ? { refreshTokenEnc: sealToken(workspaceId, connectionId, "refresh_token", tokens.refreshToken) } : {}),
  }
}

/** PKCE verifier sealed to its OAuth state nonce. */
export function sealCodeVerifier(nonce: string, verifier: string): string {
  return encryptSecret(verifier, `oauth_state:${nonce}`)
}

export function openCodeVerifier(nonce: string, sealed: string): string {
  return decryptSecret(sealed, `oauth_state:${nonce}`)
}

/** The decrypted TokenSet, for provider revoke on disconnect only. */
export function tokenSetForRevoke(connection: StoredConnection): TokenSet | undefined {
  try {
    const accessToken = openToken(connection, "access_token")
    const refreshToken = openToken(connection, "refresh_token")

    if (!accessToken && !refreshToken) return undefined

    return {
      accessToken: accessToken ?? "",
      ...(refreshToken ? { refreshToken } : {}),
      ...(connection.tokenType ? { tokenType: connection.tokenType } : {}),
      scopes: connection.scopes,
    }
  } catch {
    return undefined
  }
}

function expiring(connection: StoredConnection, now: number): boolean {
  if (!connection.expiresAt) return false

  return Date.parse(connection.expiresAt) - REFRESH_SKEW_MS < now
}

function isInvalidGrant(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.kind === "auth" || /invalid_grant|interaction_required|AADSTS7000[0-9]/i.test(error.providerCode ?? "")
  }
  return false
}

export type TokenDeps = ReauthDeps & {
  store?: IntegrationStore
  provider?: (id: string) => IntegrationProvider | undefined
  now?: () => number
}

/**
 * A usable access token for an active connection, refreshing it first when
 * it expires within 120 s. Throws ProviderError(`auth`) when the connection
 * is not active or the refresh is rejected (the connection is then
 * `needs_reauth`), `config` when the provider cannot refresh.
 */
export async function getAccessToken(workspaceId: string, connectionId: string, deps: TokenDeps = {}): Promise<string> {
  const store = deps.store ?? (await getIntegrationStore())
  const now = deps.now ?? Date.now
  const current = await store.getConnection(workspaceId, connectionId)

  if (!current || current.status !== "active") {
    throw new ProviderError("auth", "connection is not active")
  }
  if (!expiring(current, now())) {
    const token = openToken(current, "access_token")

    if (!token) throw new ProviderError("auth", "connection has no access token")
    return token
  }

  let refreshFailure: unknown

  const token = await store.withConnectionLock(workspaceId, connectionId, async (connection, update) => {
    if (!connection || connection.status !== "active") throw new ProviderError("auth", "connection is not active")

    // Another job refreshed while we waited for the lock.
    if (!expiring(connection, now())) {
      const fresh = openToken(connection, "access_token")

      if (!fresh) throw new ProviderError("auth", "connection has no access token")
      return fresh
    }

    const refreshToken = openToken(connection, "refresh_token")
    const provider = (deps.provider ?? getProvider)(connection.provider)

    if (!refreshToken || !provider?.oauth?.refresh) {
      // No refresh path: use the token until the provider rejects it.
      const existing = openToken(connection, "access_token")

      if (!existing) throw new ProviderError("auth", "connection has no access token")
      return existing
    }

    let refreshed: TokenSet

    try {
      refreshed = await provider.oauth.refresh(refreshToken)
    } catch (error) {
      if (isInvalidGrant(error)) {
        refreshFailure = error
        return undefined
      }
      await update({ lastError: storedIntegrationError(error, connection.provider) })
      throw error
    }

    await update({
      ...sealTokenSet(workspaceId, connectionId, refreshed),
      expiresAt: refreshed.expiresAt ?? null,
      ...(refreshed.tokenType ? { tokenType: refreshed.tokenType } : {}),
      ...(refreshed.scopes.length ? { scopes: refreshed.scopes } : {}),
      lastRefreshedAt: new Date(now()).toISOString(),
      lastError: null,
    })

    return refreshed.accessToken
  })

  if (token === undefined) {
    await markConnectionNeedsReauth(workspaceId, connectionId, refreshFailure ?? "refresh rejected", {
      store,
      ...(deps.notify ? { notify: deps.notify } : {}),
    })
    throw new ProviderError("auth", "refresh rejected; reconnect required", { providerCode: "invalid_grant" })
  }

  return token
}
