/**
 * Notion public-integration OAuth (docs/parity/m8.md, C1). Owner: Package C.
 *
 * - Authorize: https://api.notion.com/v1/oauth/authorize?owner=user&response_type=code
 * - Exchange / refresh: POST https://api.notion.com/v1/oauth/token with HTTP
 *   Basic client credentials. The account is the Notion workspace
 *   (`workspace_id`, label `workspace_name`); `bot_id` goes in config.
 * - No PKCE: Notion does not document it for public integrations.
 *
 * Token exchange errors never carry Notion's `error_description`.
 */
import { providerAuthorizeUrl } from "@/lib/integrations/core/http"
import {
  ProviderError,
  type OAuthExchangeResult,
  type ProviderFetch,
  type TokenSet,
} from "@/lib/integrations/core/types"
import { NOTION_API_ORIGIN, notionErrorFrom } from "@/lib/integrations/notion/client"

export function notionClientConfig(env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.NOTION_CLIENT_ID?.trim()
  const clientSecret = env.NOTION_CLIENT_SECRET?.trim()

  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

export function notionAuthorizeUrl(
  params: { state: string; redirectUri: string },
  env: NodeJS.ProcessEnv = process.env
): string {
  const config = notionClientConfig(env)

  if (!config) throw new ProviderError("config", "notion_not_configured")

  // Through the shared builder: authorize-host allowlist and the fake-mode
  // rewrite to `<fake>/api.notion.com/...`.
  return providerAuthorizeUrl(
    "notion",
    `${NOTION_API_ORIGIN}/v1/oauth/authorize`,
    { client_id: config.clientId, response_type: "code", owner: "user", redirect_uri: params.redirectUri, state: params.state },
    env
  )
}

type NotionTokenResponse = {
  access_token?: string
  refresh_token?: string | null
  token_type?: string
  expires_in?: number
  bot_id?: string
  workspace_id?: string
  workspace_name?: string | null
  workspace_icon?: string | null
}

async function tokenRequest(
  fetchImpl: ProviderFetch,
  body: Record<string, string>,
  env: NodeJS.ProcessEnv
): Promise<NotionTokenResponse> {
  const config = notionClientConfig(env)

  if (!config) throw new ProviderError("config", "notion_not_configured")

  const response = await fetchImpl("notion", `${NOTION_API_ORIGIN}/v1/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await notionErrorFrom(response)

    // invalid_grant on a code exchange is a bad/expired code, not a broken connection.
    throw body.grant_type === "authorization_code" && error.kind === "auth"
      ? new ProviderError("invalid", "notion_invalid_grant", { providerCode: error.providerCode ?? "invalid_grant" })
      : error
  }

  const json = (await response.json().catch(() => ({}))) as NotionTokenResponse

  if (!json.access_token) throw new ProviderError("retryable", "notion_token_missing")

  return json
}

function tokenSet(json: NotionTokenResponse): TokenSet {
  return {
    accessToken: json.access_token as string,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(json.expires_in ? { expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString() } : {}),
    tokenType: json.token_type ?? "bearer",
    scopes: [],
  }
}

export async function exchangeNotionCode(
  code: string,
  params: { redirectUri: string },
  deps: { fetch: ProviderFetch; env?: NodeJS.ProcessEnv }
): Promise<OAuthExchangeResult> {
  const json = await tokenRequest(
    deps.fetch,
    { grant_type: "authorization_code", code, redirect_uri: params.redirectUri },
    deps.env ?? process.env
  )

  if (!json.workspace_id) throw new ProviderError("retryable", "notion_workspace_missing")

  return {
    ...tokenSet(json),
    account: { externalId: json.workspace_id, label: json.workspace_name?.trim() || "Notion" },
    config: { ...(json.bot_id ? { botId: json.bot_id } : {}) },
  }
}

export async function refreshNotionToken(
  refreshToken: string,
  deps: { fetch: ProviderFetch; env?: NodeJS.ProcessEnv }
): Promise<TokenSet> {
  return tokenSet(
    await tokenRequest(deps.fetch, { grant_type: "refresh_token", refresh_token: refreshToken }, deps.env ?? process.env)
  )
}
