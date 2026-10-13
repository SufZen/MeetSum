/**
 * OAuth start and callback (docs/parity/m8.md "OAuth flow"). Owner:
 * Package A. Routes stay thin and call these.
 *
 * Start: provider ∈ registry, permission (`integrations:manage` for
 * workspace providers), `configured()`, a valid env redirect base; then a
 * nonce row (+ sealed PKCE verifier), the signed state, the nonce cookie and
 * the provider redirect.
 *
 * Callback, in order: signature + expiry → cookie nonce = state nonce = DB
 * row, unused (marked used atomically) → session user = state user and
 * still a member of state.ws with the permission (re-checked) → route
 * provider = state provider → provider `error=` → exchange → encrypted
 * upsert → audit → redirect to the stored `returnTo`. Every failure
 * redirects with a fixed `integration_error` code.
 */
import { can, type SessionContext } from "@/lib/auth/authz"
import { auditIntegration } from "@/lib/integrations/core/audit"
import { isPersonalProvider, upsertConnectionFromOAuth } from "@/lib/integrations/core/connections"
import { integrationLog } from "@/lib/integrations/core/errors"
import {
  createOAuthNonce,
  defaultIntegrationsReturnTo,
  oauthRedirectUri,
  OAUTH_STATE_TTL_MS,
  safeIntegrationReturnTo,
  signOAuthState,
  verifyOAuthState,
  withIntegrationError,
} from "@/lib/integrations/core/oauth-state"
import { codeChallengeS256, createCodeVerifier } from "@/lib/integrations/core/pkce"
import { getProvider, isProviderId } from "@/lib/integrations/core/registry"
import { getIntegrationStore, type IntegrationStore } from "@/lib/integrations/core/store"
import { openCodeVerifier, sealCodeVerifier } from "@/lib/integrations/core/tokens"
import { ProviderError, type IntegrationErrorCode, type IntegrationProvider, type ProviderId } from "@/lib/integrations/core/types"
import type { WorkspaceRole } from "@/lib/workspaces/types"

export type OAuthDeps = {
  store?: IntegrationStore
  env?: NodeJS.ProcessEnv
  getProvider?: (id: string) => IntegrationProvider | undefined
  now?: () => number
}

export type StartOAuthResult =
  | { ok: true; location: string; nonce: string }
  | { ok: false; status: number; code: "not_found" | "forbidden" | "integration_not_configured" }

export function requiredPermission(provider: ProviderId) {
  return isPersonalProvider(provider) ? ("integrations:connect" as const) : ("integrations:manage" as const)
}

export async function startOAuth(
  input: { provider: string; workspaceId: string; userId: string; role: WorkspaceRole; returnTo?: string | null; locale?: string },
  deps: OAuthDeps = {}
): Promise<StartOAuthResult> {
  const env = deps.env ?? process.env
  const provider = (deps.getProvider ?? getProvider)(input.provider)

  if (!provider || !isProviderId(input.provider) || !provider.oauth) return { ok: false, status: 404, code: "not_found" }
  if (!can(input.role, requiredPermission(input.provider))) return { ok: false, status: 403, code: "forbidden" }
  if (!provider.configured(env)) return { ok: false, status: 409, code: "integration_not_configured" }

  const redirectUri = oauthRedirectUri(input.provider, env)

  if (!redirectUri) return { ok: false, status: 409, code: "integration_not_configured" }

  const store = deps.store ?? (await getIntegrationStore())
  const now = (deps.now ?? Date.now)()
  const nonce = createOAuthNonce()
  const verifier = provider.oauth.pkce ? createCodeVerifier() : undefined
  const expiresAt = now + OAUTH_STATE_TTL_MS

  await store.createOAuthState({
    nonce,
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: input.provider,
    ...(verifier ? { codeVerifierEnc: sealCodeVerifier(nonce, verifier) } : {}),
    returnTo: safeIntegrationReturnTo(input.returnTo, input.locale),
    expiresAt: new Date(expiresAt).toISOString(),
  })

  const state = signOAuthState({ n: nonce, p: input.provider, ws: input.workspaceId, u: input.userId, exp: expiresAt }, env)
  const location = provider.oauth.authorizeUrl({
    state,
    redirectUri,
    ...(verifier ? { codeChallenge: codeChallengeS256(verifier) } : {}),
  })

  return { ok: true, location, nonce }
}

export type CallbackResult = { location: string; connectionId?: string; code?: IntegrationErrorCode }

function roleIn(session: SessionContext, workspaceId: string): WorkspaceRole | undefined {
  return session.memberships.find((membership) => membership.workspaceId === workspaceId)?.role
}

export async function completeOAuth(
  input: { provider: string; session: SessionContext; query: URLSearchParams; cookieNonce?: string },
  deps: OAuthDeps = {}
): Promise<CallbackResult> {
  const env = deps.env ?? process.env
  const fail = (code: IntegrationErrorCode, returnTo = defaultIntegrationsReturnTo()): CallbackResult => ({
    location: withIntegrationError(returnTo, code),
    code,
  })

  // 1. Signature and expiry.
  const verified = verifyOAuthState(input.query.get("state"), { env, now: (deps.now ?? Date.now)() })

  if (!verified.ok) return fail(verified.code)

  const state = verified.payload

  // 2. Cookie nonce = state nonce = DB row, single use.
  if (!input.cookieNonce || input.cookieNonce !== state.n) return fail("invalid_state")

  const store = deps.store ?? (await getIntegrationStore())
  const row = await store.consumeOAuthState(state.n, new Date((deps.now ?? Date.now)()))

  if (!row || row.workspaceId !== state.ws || row.userId !== state.u || row.provider !== state.p) return fail("invalid_state")

  const returnTo = safeIntegrationReturnTo(row.returnTo)

  // 3. Same user, still a member with the permission (re-checked now).
  if (input.session.user.id !== state.u) return fail("forbidden", returnTo)
  if (!isProviderId(state.p)) return fail("provider_mismatch", returnTo)

  const role = roleIn(input.session, state.ws)

  if (!role || !can(role, requiredPermission(state.p))) return fail("forbidden", returnTo)

  // 4. Route provider = state provider.
  if (input.provider !== state.p) return fail("provider_mismatch", returnTo)

  // 5. Provider-side denial.
  if (input.query.get("error")) return fail("denied", returnTo)

  const provider = (deps.getProvider ?? getProvider)(state.p)
  const redirectUri = oauthRedirectUri(state.p, env)
  const code = input.query.get("code")

  if (!provider?.oauth || !provider.configured(env) || !redirectUri) return fail("not_configured", returnTo)
  if (!code || code.length > 4096) return fail("denied", returnTo)

  // 6. Exchange, upsert, audit.
  let exchange

  try {
    const codeVerifier = row.codeVerifierEnc ? openCodeVerifier(row.nonce, row.codeVerifierEnc) : undefined

    exchange = await provider.oauth.exchangeCode(code, { redirectUri, ...(codeVerifier ? { codeVerifier } : {}) })
  } catch (error) {
    integrationLog.warn(`${state.p} code exchange failed`, error)
    return fail(error instanceof ProviderError && error.providerCode === "tenant_not_allowed" ? "tenant_not_allowed" : "exchange_failed", returnTo)
  }

  const result = await upsertConnectionFromOAuth(
    {
      workspaceId: state.ws,
      provider: state.p,
      ...(isPersonalProvider(state.p) ? { userId: state.u } : {}),
      actorUserId: state.u,
      exchange,
    },
    store
  )

  if (!result.ok) return fail("cap_reached", returnTo)

  await auditIntegration(
    { workspaceId: state.ws, actor: input.session.user.email, actorUserId: state.u },
    result.created ? "integration.connection.created" : "integration.connection.updated",
    { type: "integration_connection", id: result.connection.id },
    { provider: state.p, connectionId: result.connection.id, personal: isPersonalProvider(state.p) }
  )

  return { location: returnTo, connectionId: result.connection.id }
}
