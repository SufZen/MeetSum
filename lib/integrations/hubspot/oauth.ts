/**
 * HubSpot OAuth for the workspace connection (docs/parity/m8.md, B3).
 *
 * Scopes (VERIFY against current HubSpot docs before the first live run):
 *   required `oauth crm.objects.contacts.read crm.objects.contacts.write
 *   crm.objects.deals.read`. Checked 2026-10-13: the Meetings, Notes and
 *   Tasks v3 object guides list only the contacts read/write scopes for
 *   engagement writes, so no separate meetings/notes/tasks scope is
 *   requested. Optional (`HUBSPOT_OPTIONAL_SCOPES`, default
 *   `crm.objects.owners.read`) for task-owner mapping.
 * PKCE is off: HubSpot's OAuth docs do not document PKCE for public apps
 * (confidential client with a secret); re-check before enabling.
 */
import { providerAuthorizeUrl } from "@/lib/integrations/core/http"
import { ProviderError, type OAuthExchangeResult, type ProviderFetch, type TokenSet } from "@/lib/integrations/core/types"
import { HUBSPOT_API, hubspotError } from "@/lib/integrations/hubspot/client"

export const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize"
export const HUBSPOT_SCOPES = ["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write", "crm.objects.deals.read"] as const
export const HUBSPOT_DEFAULT_OPTIONAL_SCOPES = ["crm.objects.owners.read"] as const

export type HubspotEnv = { clientId: string; clientSecret: string; optionalScopes: string[] }

export function hubspotEnv(env: NodeJS.ProcessEnv = process.env): HubspotEnv | undefined {
  const clientId = env.HUBSPOT_CLIENT_ID?.trim()
  const clientSecret = env.HUBSPOT_CLIENT_SECRET?.trim()

  if (!clientId || !clientSecret) return undefined
  return { clientId, clientSecret, optionalScopes: hubspotOptionalScopes(env) }
}

export function hubspotOptionalScopes(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.HUBSPOT_OPTIONAL_SCOPES

  if (raw === undefined) return [...HUBSPOT_DEFAULT_OPTIONAL_SCOPES]
  return raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => /^[a-z0-9._-]+$/i.test(scope) && !(HUBSPOT_SCOPES as readonly string[]).includes(scope))
}

function requireEnv(env: NodeJS.ProcessEnv): HubspotEnv {
  const config = hubspotEnv(env)

  if (!config) throw new ProviderError("config", "hubspot integration not configured")
  return config
}

export function hubspotAuthorizeUrl(params: { state: string; redirectUri: string }, env: NodeJS.ProcessEnv = process.env): string {
  const config = requireEnv(env)
  return providerAuthorizeUrl(
    "hubspot",
    HUBSPOT_AUTHORIZE_URL,
    {
      client_id: config.clientId,
      redirect_uri: params.redirectUri,
      scope: HUBSPOT_SCOPES.join(" "),
      optional_scope: config.optionalScopes.length ? config.optionalScopes.join(" ") : undefined,
      state: params.state,
    },
    env
  )
}

export type HubspotOAuthDeps = { fetch: ProviderFetch; env?: NodeJS.ProcessEnv; now?: () => Date }

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string }

async function postToken(deps: HubspotOAuthDeps, form: Record<string, string>): Promise<TokenSet> {
  const config = requireEnv(deps.env ?? process.env)
  const response = await deps.fetch("hubspot", `${HUBSPOT_API}/oauth/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...form }).toString(),
  })

  if (!response.ok) {
    const error = await hubspotError(response)

    // BAD_REFRESH_TOKEN / invalid_grant: the grant is gone → reconnect.
    if (response.status === 400 && /BAD_REFRESH_TOKEN|invalid_grant|BAD_AUTH_CODE/i.test(error.providerCode ?? "")) {
      throw new ProviderError("auth", "hubspot token grant rejected", { providerCode: error.providerCode })
    }
    throw error
  }

  const body = (await response.json()) as TokenResponse

  if (!body.access_token) throw new ProviderError("invalid", "hubspot token response without access token")

  const now = (deps.now ?? (() => new Date()))()

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || undefined,
    expiresAt: typeof body.expires_in === "number" ? new Date(now.getTime() + body.expires_in * 1000).toISOString() : undefined,
    tokenType: body.token_type,
    scopes: [],
  }
}

type AccessTokenInfo = { active?: boolean; hub_id?: number | string; hub_domain?: string; scopes?: string[] }

/**
 * Token introspection: hub id/domain and granted scopes.
 *
 * VERIFY against current HubSpot docs before the first live run. Checked
 * 2026-10-13: `POST /oauth/v3/token/introspect`, form-urlencoded
 * `client_id`, `client_secret`, `token`, `token_type_hint` (the versioned
 * reference also lists `/oauth/2026-03/token/introspect`); the response has
 * `hub_id` and `scopes` (required) and `hub_domain` (optional). It replaces
 * the legacy `GET /oauth/v1/access-tokens/{token}`, which put the access
 * token in the URL path (proxy and access logs). No account-info fallback is
 * needed: `hub_id` and `scopes` are required fields of the response and the
 * label falls back to `HubSpot <hub_id>` without `hub_domain`.
 */
export async function hubspotTokenInfo(
  fetch: ProviderFetch,
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<AccessTokenInfo> {
  const config = requireEnv(env)
  const response = await fetch("hubspot", `${HUBSPOT_API}/oauth/v3/token/introspect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      token: accessToken,
      token_type_hint: "access_token",
    }).toString(),
  })

  if (!response.ok) throw await hubspotError(response)

  const info = (await response.json()) as AccessTokenInfo

  if (info.active === false) throw new ProviderError("auth", "hubspot token inactive")
  return info
}

export async function exchangeHubspotCode(
  code: string,
  params: { redirectUri: string },
  deps: HubspotOAuthDeps
): Promise<OAuthExchangeResult> {
  const tokens = await postToken(deps, { grant_type: "authorization_code", code, redirect_uri: params.redirectUri })
  const info = await hubspotTokenInfo(deps.fetch, tokens.accessToken, deps.env ?? process.env)
  const hubId = info.hub_id === undefined ? "" : String(info.hub_id)

  if (!/^\d+$/.test(hubId)) throw new ProviderError("invalid", "hubspot token info without hub id")

  return {
    ...tokens,
    scopes: Array.isArray(info.scopes) ? info.scopes.filter((scope) => typeof scope === "string") : [],
    account: { externalId: hubId, label: info.hub_domain?.trim() || `HubSpot ${hubId}` },
    config: { hubId },
  }
}

export async function refreshHubspotToken(refreshToken: string, deps: HubspotOAuthDeps): Promise<TokenSet> {
  return postToken(deps, { grant_type: "refresh_token", refresh_token: refreshToken })
}

/**
 * Best-effort revoke of the refresh token; a 404 is already revoked.
 *
 * VERIFY against current HubSpot docs before the first live run. Checked
 * 2026-10-13: `POST /oauth/v3/token/revoke`, form-urlencoded `client_id`,
 * `client_secret`, `token`, `token_type_hint` (the versioned reference also
 * lists `/oauth/2026-03/token/revoke`). It replaces the legacy
 * `DELETE /oauth/v1/refresh-tokens/{token}`, which put the refresh token in
 * the URL path.
 */
export async function revokeHubspotToken(tokens: TokenSet, deps: HubspotOAuthDeps): Promise<void> {
  if (!tokens.refreshToken) return

  const config = requireEnv(deps.env ?? process.env)
  const response = await deps.fetch("hubspot", `${HUBSPOT_API}/oauth/v3/token/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      token: tokens.refreshToken,
      token_type_hint: "refresh_token",
    }).toString(),
  })

  if (!response.ok && response.status !== 404) throw await hubspotError(response)
}
