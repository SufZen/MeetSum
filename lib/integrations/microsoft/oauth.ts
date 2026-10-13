/**
 * Microsoft 365 delegated OAuth for the personal calendar connection
 * (docs/parity/m8.md, B1). Authorization code + PKCE S256 against the v2.0
 * endpoints; identity comes from Graph `/me` (the id_token is never used for
 * authorization, its `tid` only feeds the MS_ALLOWED_TENANTS check).
 *
 * `OnlineMeetings.Read` is deliberately NOT requested: `onlineMeeting.joinUrl`
 * is returned with `Calendars.Read`, and the extra scope would force a tenant
 * admin-consent prompt.
 */
import { providerAuthorizeUrl } from "@/lib/integrations/core/http"
import {
  type OAuthExchangeResult,
  ProviderError,
  type ProviderFetch,
  type TokenSet,
} from "@/lib/integrations/core/types"
import { GRAPH_BASE, LOGIN_BASE, graphGet, tokenEndpointError } from "@/lib/integrations/microsoft/graph"

export const MICROSOFT_SCOPES = ["openid", "profile", "email", "offline_access", "User.Read", "Calendars.Read"] as const

export type MicrosoftEnv = {
  clientId: string
  clientSecret: string
  tenant: string
  /** Lowercase tenant ids; empty = any tenant. */
  allowedTenants: string[]
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/i

/** The tenant path segment: a GUID, `organizations`, `common` or a domain. */
export function isValidMicrosoftTenant(tenant: string): boolean {
  return tenant === "organizations" || tenant === "common" || GUID.test(tenant) || DOMAIN.test(tenant)
}

function text(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim()

    if (value) return value
  }
  return undefined
}

/** `MS_*` with the `AZURE_*` fallbacks; undefined when not configured. */
export function microsoftEnv(env: NodeJS.ProcessEnv = process.env): MicrosoftEnv | undefined {
  const clientId = text(env, "MS_CLIENT_ID", "AZURE_CLIENT_ID")
  const clientSecret = text(env, "MS_CLIENT_SECRET", "AZURE_CLIENT_SECRET")
  const tenant = text(env, "MS_TENANT", "AZURE_TENANT_ID") ?? "organizations"

  if (!clientId || !clientSecret || !isValidMicrosoftTenant(tenant)) return undefined

  return {
    clientId,
    clientSecret,
    tenant,
    allowedTenants: (env.MS_ALLOWED_TENANTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  }
}

function requireEnv(env: NodeJS.ProcessEnv): MicrosoftEnv {
  const config = microsoftEnv(env)

  if (!config) throw new ProviderError("config", "microsoft integration not configured")
  return config
}

export function microsoftAuthorizeUrl(
  params: { state: string; redirectUri: string; codeChallenge?: string },
  env: NodeJS.ProcessEnv = process.env
): string {
  const config = requireEnv(env)

  if (!params.codeChallenge) throw new ProviderError("config", "microsoft requires PKCE")

  return providerAuthorizeUrl(
    "microsoft",
    `${LOGIN_BASE}/${encodeURIComponent(config.tenant)}/oauth2/v2.0/authorize`,
    {
      client_id: config.clientId,
      response_type: "code",
      response_mode: "query",
      redirect_uri: params.redirectUri,
      scope: MICROSOFT_SCOPES.join(" "),
      state: params.state,
      prompt: "select_account",
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
    },
    env
  )
}

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  id_token?: string
}

async function postToken(
  fetch: ProviderFetch,
  config: MicrosoftEnv,
  form: Record<string, string>,
  now: () => Date
): Promise<TokenSet & { idToken?: string }> {
  const response = await fetch(
    "microsoft",
    `${LOGIN_BASE}/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...form }).toString(),
    }
  )

  if (!response.ok) throw await tokenEndpointError(response)

  const body = (await response.json()) as TokenResponse

  if (!body.access_token) throw new ProviderError("invalid", "microsoft token response without access token")

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || undefined,
    expiresAt:
      typeof body.expires_in === "number"
        ? new Date(now().getTime() + body.expires_in * 1000).toISOString()
        : undefined,
    tokenType: body.token_type,
    scopes: (body.scope ?? "").split(/\s+/).filter(Boolean),
    idToken: body.id_token,
  }
}

/** Reads `tid` from an id_token payload without trusting it for anything but the tenant allowlist. */
export function tenantFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1]

  if (!payload) return undefined

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { tid?: unknown }

    return typeof claims.tid === "string" && GUID.test(claims.tid) ? claims.tid.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

type GraphMe = { id?: string; mail?: string | null; userPrincipalName?: string | null; displayName?: string | null }

export type MicrosoftOAuthDeps = {
  fetch: ProviderFetch
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

export async function exchangeMicrosoftCode(
  code: string,
  params: { redirectUri: string; codeVerifier?: string },
  deps: MicrosoftOAuthDeps
): Promise<OAuthExchangeResult> {
  const config = requireEnv(deps.env ?? process.env)

  if (!params.codeVerifier) throw new ProviderError("config", "microsoft requires PKCE")

  const { idToken, ...tokens } = await postToken(
    deps.fetch,
    config,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      scope: MICROSOFT_SCOPES.join(" "),
    },
    deps.now ?? (() => new Date())
  )
  const tenantId = tenantFromIdToken(idToken)

  if (config.allowedTenants.length && (!tenantId || !config.allowedTenants.includes(tenantId))) {
    throw new ProviderError("forbidden", "microsoft tenant not allowed", { providerCode: "tenant_not_allowed" })
  }

  const me = await graphGet<GraphMe>(
    deps.fetch,
    tokens.accessToken,
    `${GRAPH_BASE}/me?$select=id,mail,userPrincipalName,displayName`
  )

  if (!me.id) throw new ProviderError("invalid", "graph /me without id")

  const label = (me.mail || me.userPrincipalName || me.displayName || me.id).trim()

  return {
    ...tokens,
    account: { externalId: `${tenantId ?? "unknown"}:${me.id}`, label },
    config: { calendarSyncEnabled: false, ...(tenantId ? { tenantId } : {}) },
  }
}

/** Refresh; the caller (A's token store) must always persist the rotated refresh token. */
export async function refreshMicrosoftToken(refreshToken: string, deps: MicrosoftOAuthDeps): Promise<TokenSet> {
  const config = requireEnv(deps.env ?? process.env)
  const { idToken: _ignored, ...tokens } = await postToken(
    deps.fetch,
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken, scope: MICROSOFT_SCOPES.join(" ") },
    deps.now ?? (() => new Date())
  )

  void _ignored
  return tokens
}
