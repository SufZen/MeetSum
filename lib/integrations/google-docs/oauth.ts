/**
 * Google OAuth for the personal `google_drive` connection used by the Docs
 * export (docs/parity/m8.md, C2). Owner: Package C.
 *
 * - Authorize: accounts.google.com (a browser redirect target, never
 *   fetched) with PKCE S256, scope `drive.file` (only files MeetSum
 *   creates), `access_type=offline`, `prompt=consent`,
 *   `include_granted_scopes=true`.
 * - Token / refresh / revoke: oauth2.googleapis.com.
 * - Account: the Drive user (`about.user.permissionId`, label = email),
 *   readable with `drive.file`; no `openid` scope is requested.
 * - Reuses the Google OAuth client: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`,
 *   falling back to the sign-in client `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`.
 */
import {
  ProviderError,
  type OAuthExchangeResult,
  type ProviderFetch,
  type TokenSet,
} from "@/lib/integrations/core/types"
import { DRIVE_API, googleErrorFrom } from "@/lib/integrations/google-docs/client"
import { providerAuthorizeUrl } from "@/lib/integrations/core/http"

export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"
export const GOOGLE_DOCS_SCOPE = "https://www.googleapis.com/auth/documents"
const AUTHORIZE_ORIGIN = "https://accounts.google.com"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const REVOKE_URL = "https://oauth2.googleapis.com/revoke"

export function googleDocsClientConfig(env: NodeJS.ProcessEnv = process.env) {
  const clientId = (env.GOOGLE_CLIENT_ID ?? env.GOOGLE_OAUTH_CLIENT_ID)?.trim()
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? env.GOOGLE_OAUTH_CLIENT_SECRET)?.trim()

  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

export function googleDocsAuthorizeUrl(
  params: { state: string; redirectUri: string; codeChallenge?: string },
  env: NodeJS.ProcessEnv = process.env
): string {
  const config = googleDocsClientConfig(env)

  if (!config) throw new ProviderError("config", "google_docs_not_configured")
  if (!params.codeChallenge) throw new ProviderError("config", "google_docs_pkce_required")

  return providerAuthorizeUrl(
    "google_drive",
    `${AUTHORIZE_ORIGIN}/o/oauth2/v2/auth`,
    {
      client_id: config.clientId,
      redirect_uri: params.redirectUri,
      response_type: "code",
      scope: GOOGLE_DRIVE_FILE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      state: params.state,
    },
    env
  )
}

type GoogleTokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
}

async function tokenRequest(fetchImpl: ProviderFetch, form: Record<string, string>, env: NodeJS.ProcessEnv) {
  const config = googleDocsClientConfig(env)

  if (!config) throw new ProviderError("config", "google_docs_not_configured")

  const response = await fetchImpl("google_drive", TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, client_id: config.clientId, client_secret: config.clientSecret }).toString(),
  })

  if (!response.ok) {
    const error = await googleErrorFrom(response)

    throw form.grant_type === "authorization_code" && (error.kind === "auth" || error.kind === "invalid")
      ? new ProviderError("invalid", "google_docs_invalid_grant")
      : error.kind === "invalid" && error.providerCode === "invalid_grant"
        ? new ProviderError("auth", "google_docs_invalid_grant")
        : error
  }

  const json = (await response.json().catch(() => ({}))) as GoogleTokenResponse

  if (!json.access_token) throw new ProviderError("retryable", "google_docs_token_missing")

  return json
}

function tokenSet(json: GoogleTokenResponse): TokenSet {
  return {
    accessToken: json.access_token as string,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(json.expires_in ? { expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString() } : {}),
    tokenType: json.token_type ?? "Bearer",
    scopes: (json.scope ?? GOOGLE_DRIVE_FILE_SCOPE).split(/\s+/).filter(Boolean),
  }
}

export async function exchangeGoogleDocsCode(
  code: string,
  params: { redirectUri: string; codeVerifier?: string },
  deps: { fetch: ProviderFetch; env?: NodeJS.ProcessEnv }
): Promise<OAuthExchangeResult> {
  if (!params.codeVerifier) throw new ProviderError("config", "google_docs_pkce_required")

  const tokens = tokenSet(
    await tokenRequest(
      deps.fetch,
      { grant_type: "authorization_code", code, redirect_uri: params.redirectUri, code_verifier: params.codeVerifier },
      deps.env ?? process.env
    )
  )

  if (!tokens.scopes.includes(GOOGLE_DRIVE_FILE_SCOPE)) throw new ProviderError("forbidden", "google_docs_scope_denied")

  const response = await deps.fetch("google_drive", `${DRIVE_API}/about?fields=user(permissionId,emailAddress,displayName)`, {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  })

  if (!response.ok) throw await googleErrorFrom(response)

  const about = (await response.json().catch(() => ({}))) as {
    user?: { permissionId?: string; emailAddress?: string; displayName?: string }
  }
  const externalId = about.user?.permissionId

  if (!externalId) throw new ProviderError("retryable", "google_docs_account_missing")

  return {
    ...tokens,
    account: { externalId, label: about.user?.emailAddress || about.user?.displayName || "Google Drive" },
  }
}

export async function refreshGoogleDocsToken(
  refreshToken: string,
  deps: { fetch: ProviderFetch; env?: NodeJS.ProcessEnv }
): Promise<TokenSet> {
  return tokenSet(
    await tokenRequest(deps.fetch, { grant_type: "refresh_token", refresh_token: refreshToken }, deps.env ?? process.env)
  )
}

/** Best-effort revoke on disconnect (the refresh token revokes the grant). */
export async function revokeGoogleDocsToken(tokens: TokenSet, deps: { fetch: ProviderFetch }): Promise<void> {
  const token = tokens.refreshToken ?? tokens.accessToken

  await deps.fetch("google_drive", REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  })
}

/** "Test connection": tokeninfo, with the token in the body, never the URL. */
export async function googleDocsTokenInfo(accessToken: string, deps: { fetch: ProviderFetch }): Promise<void> {
  const response = await deps.fetch("google_drive", "https://oauth2.googleapis.com/tokeninfo", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: accessToken }).toString(),
  })

  if (!response.ok) throw await googleErrorFrom(response)
}
