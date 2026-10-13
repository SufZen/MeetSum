/**
 * Token custody (docs/parity/m8.md, "Token secrecy" and "Token refresh").
 * Owner: Package A. The ONLY module that decrypts integration tokens.
 *
 * - Tokens are AES-256-GCM `v2` ciphertexts bound to
 *   `${workspaceId}:${connectionId}:${field}` (a ciphertext copied to another
 *   row or field fails to decrypt).
 * - `getAccessToken` refreshes when `expires_at − 120 s < now` under a short
 *   refresh lease (migration 029; no transaction or row lock is held across
 *   the provider call), so concurrent jobs never race a rotating refresh
 *   token; a newly returned refresh token is always persisted.
 * - `invalid_grant` (or any `auth` failure) → `needs_reauth`.
 *
 * Routes never import this module (the route-coverage test checks it).
 */
import { decryptSecret, encryptSecret } from "@/lib/auth/secret-crypto"
import { integrationLog, storedIntegrationError } from "@/lib/integrations/core/errors"
import { markConnectionNeedsReauth, type ReauthDeps } from "@/lib/integrations/core/reauth"
import { getProvider } from "@/lib/integrations/core/registry"
import { getIntegrationStore, type ConnectionPatch, type IntegrationStore, type StoredConnection } from "@/lib/integrations/core/store"
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

/** The connection is revoked, flagged or gone: a state error, never a reauth trigger. */
function connectionInactive(): ProviderError {
  return new ProviderError("auth", "connection is not active", { providerCode: "connection_inactive" })
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
  /** Pause while another process holds the refresh lease (tests inject a short one). */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Refresh lease length. The provider call is capped at 15 s by
 * `providerFetch`, so a live holder always finishes (or fails) well within
 * it; an expired lease belongs to a crashed holder and is taken over.
 */
export const REFRESH_LEASE_MS = 45_000
const LEASE_POLL_MS = 250

/**
 * A usable access token for an active connection, refreshing it first when
 * it expires within 120 s. Throws ProviderError(`auth`) when the connection
 * is not active (`connection_inactive`), changed during the refresh
 * (`connection_changed`) or the refresh is rejected (`invalid_grant`; the
 * connection is then `needs_reauth`), `retryable` when another holder's
 * refresh did not finish in time.
 */
export async function getAccessToken(workspaceId: string, connectionId: string, deps: TokenDeps = {}): Promise<string> {
  const store = deps.store ?? (await getIntegrationStore())
  const now = deps.now ?? Date.now
  const current = await store.getConnection(workspaceId, connectionId)

  if (!current || current.status !== "active") throw connectionInactive()
  if (!expiring(current, now())) return accessTokenOf(current)

  const key = `${workspaceId}:${connectionId}`
  const inFlight = refreshesInFlight.get(key)

  if (inFlight) return inFlight

  const refresh = refreshWithLease(store, workspaceId, connectionId, now, deps).finally(() => {
    refreshesInFlight.delete(key)
  })

  refreshesInFlight.set(key, refresh)
  return refresh
}

/** In-process single flight; the refresh lease serializes across processes. */
const refreshesInFlight = new Map<string, Promise<string>>()

function accessTokenOf(connection: StoredConnection): string {
  const token = openToken(connection, "access_token")

  if (!token) throw new ProviderError("auth", "connection has no access token")
  return token
}

/**
 * Lease-based refresh (migration 029). Why a lease and not the row lock:
 * `select … for update` held a transaction (and a pooled connection) open
 * across the provider's token call, and anything written inside it (the
 * `lastError` of a failed refresh) was rolled back when the error was
 * rethrown. Now:
 *  1. take the lease with one conditional autocommitted update
 *     (`active`, same generation, no live lease); on a miss, wait for the
 *     holder and re-read (its fresh token is then used: single flight);
 *  2. call the provider with NO transaction or lock open;
 *  3. write the tokens with a compare-and-set on the generation read in 1,
 *     clearing the lease; a disconnect/reconnect meanwhile bumped the
 *     generation, so the write loses and the orphan tokens are revoked;
 *  4. on failure, clear the lease and record `lastError` in the same CAS
 *     write (committed on its own), or flag `needs_reauth` (CAS on the
 *     same generation) for `invalid_grant`.
 */
async function refreshWithLease(
  store: IntegrationStore,
  workspaceId: string,
  connectionId: string,
  now: () => number,
  deps: TokenDeps
): Promise<string> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const waitUntil = Date.now() + REFRESH_LEASE_MS + 5_000

  for (;;) {
    const connection = await store.getConnection(workspaceId, connectionId)

    if (!connection || connection.status !== "active") throw connectionInactive()
    // Another process refreshed while we waited.
    if (!expiring(connection, now())) return accessTokenOf(connection)

    const provider = (deps.provider ?? getProvider)(connection.provider)
    const refresh = provider?.oauth?.refresh

    // No refresh path: use the token until the provider rejects it.
    if (!openToken(connection, "refresh_token") || !provider || !refresh) return accessTokenOf(connection)

    const leased = await store.acquireRefreshLease(
      workspaceId,
      connectionId,
      connection.generation,
      new Date(now() + REFRESH_LEASE_MS),
      new Date(now())
    )

    if (!leased) {
      if (Date.now() > waitUntil) {
        throw new ProviderError("retryable", "token refresh in progress", { providerCode: "refresh_in_progress" })
      }
      await sleep(LEASE_POLL_MS)
      continue
    }

    return refreshLeased(store, leased, provider, refresh, now, deps)
  }
}

async function refreshLeased(
  store: IntegrationStore,
  connection: StoredConnection,
  provider: IntegrationProvider,
  refresh: (refreshToken: string) => Promise<TokenSet>,
  now: () => number,
  deps: TokenDeps
): Promise<string> {
  const { workspaceId, id: connectionId, generation } = connection
  const release = (patch: ConnectionPatch = {}) =>
    store.updateConnectionIfCurrent(workspaceId, connectionId, generation, { ...patch, refreshLeaseUntil: null }).catch(() => undefined)
  const refreshToken = openToken(connection, "refresh_token")

  if (!expiring(connection, now()) || !refreshToken) {
    await release()
    return accessTokenOf(connection)
  }

  let refreshed: TokenSet

  try {
    refreshed = await refresh(refreshToken)
  } catch (error) {
    if (isInvalidGrant(error)) {
      await release()
      // CAS on the generation that held the rejected grant: a reconnect
      // meanwhile keeps its fresh connection active.
      await markConnectionNeedsReauth(workspaceId, connectionId, error, {
        store,
        generation,
        ...(deps.notify ? { notify: deps.notify } : {}),
      })
      throw new ProviderError("auth", "refresh rejected; reconnect required", { providerCode: "invalid_grant" })
    }
    // Committed on its own, after the provider call (never rolled back).
    await release({ lastError: storedIntegrationError(error, connection.provider) })
    throw error
  }

  // Compare-and-set: discarded when a disconnect/reconnect won the race.
  const written = await store.updateConnectionIfCurrent(workspaceId, connectionId, generation, {
    ...sealTokenSet(workspaceId, connectionId, refreshed),
    expiresAt: refreshed.expiresAt ?? null,
    ...(refreshed.tokenType ? { tokenType: refreshed.tokenType } : {}),
    ...(refreshed.scopes.length ? { scopes: refreshed.scopes } : {}),
    lastRefreshedAt: new Date(now()).toISOString(),
    lastError: null,
    refreshLeaseUntil: null,
  })

  if (!written) {
    // The fresh tokens belong to a connection that no longer exists: revoke them.
    if (provider.oauth?.revoke) {
      await provider.oauth.revoke(refreshed).catch((error: unknown) => {
        integrationLog.warn("revoke of a discarded refresh failed", error)
      })
    }
    throw new ProviderError("auth", "connection changed during refresh", { providerCode: "connection_changed" })
  }

  return refreshed.accessToken
}
