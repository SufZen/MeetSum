/**
 * Slack OAuth v2 (docs/parity/m8.md A9), workspace connection. Owner:
 * Package A. Bot scopes `chat:write,chat:write.public,channels:read`
 * (`SLACK_SCOPES` overrides; `groups:read` with `SLACK_PRIVATE_CHANNELS`).
 * No PKCE (Slack does not support it for confidential clients). Token
 * rotation (`expires_in` + `refresh_token`) is supported.
 */
import { ProviderHttpError } from "@/lib/integrations/core/errors"
import { providerAuthorizeUrl } from "@/lib/integrations/core/http"
import type { OAuthExchangeResult, ProviderFetch, TokenSet } from "@/lib/integrations/core/types"
import { slackCall, type SlackResponse } from "@/lib/integrations/slack/client"

export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize"
export const SLACK_DEFAULT_SCOPES = ["chat:write", "chat:write.public", "channels:read"]
export const SLACK_COMMAND_SCOPES = ["commands", "users:read", "users:read.email"]

export function slackClientConfig(env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.SLACK_CLIENT_ID?.trim()
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim()

  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

export function slackScopes(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.SLACK_SCOPES?.split(",").map((scope) => scope.trim()).filter(Boolean)
  const scopes = new Set(configured?.length ? configured : SLACK_DEFAULT_SCOPES)

  if (env.SLACK_PRIVATE_CHANNELS === "true") scopes.add("groups:read")
  if (env.SLACK_COMMANDS_ENABLED === "true") for (const scope of SLACK_COMMAND_SCOPES) scopes.add(scope)
  return [...scopes]
}

function requireConfig(env: NodeJS.ProcessEnv) {
  const config = slackClientConfig(env)

  if (!config) throw new ProviderHttpError("config", "slack", 0)
  return config
}

export function slackAuthorizeUrl(params: { state: string; redirectUri: string }, env: NodeJS.ProcessEnv = process.env): string {
  const { clientId } = requireConfig(env)

  return providerAuthorizeUrl(
    "slack",
    SLACK_AUTHORIZE_URL,
    { client_id: clientId, scope: slackScopes(env).join(","), state: params.state, redirect_uri: params.redirectUri },
    env
  )
}

function expiresAt(response: SlackResponse): string | undefined {
  const seconds = Number(response.expires_in)

  return Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : undefined
}

function scopesOf(response: SlackResponse): string[] {
  return typeof response.scope === "string" ? response.scope.split(",").map((scope) => scope.trim()).filter(Boolean) : []
}

export async function slackExchangeCode(
  code: string,
  params: { redirectUri: string },
  options: { env?: NodeJS.ProcessEnv; fetch?: ProviderFetch } = {}
): Promise<OAuthExchangeResult> {
  const env = options.env ?? process.env
  const { clientId, clientSecret } = requireConfig(env)
  const response = await slackCall(
    "oauth.v2.access",
    { client_id: clientId, client_secret: clientSecret, code, redirect_uri: params.redirectUri },
    { form: true, ...(options.fetch ? { fetch: options.fetch } : {}) }
  )
  const team = (response.team ?? {}) as { id?: string; name?: string }
  const enterprise = (response.enterprise ?? null) as { id?: string } | null
  const accessToken = typeof response.access_token === "string" ? response.access_token : ""

  if (!team.id || !accessToken) throw new ProviderHttpError("invalid", "slack", 200, { providerCode: "invalid_response" })

  const refreshToken = typeof response.refresh_token === "string" ? response.refresh_token : undefined
  const expiry = expiresAt(response)

  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiry ? { expiresAt: expiry } : {}),
    tokenType: typeof response.token_type === "string" ? response.token_type : "bot",
    scopes: scopesOf(response),
    account: {
      externalId: enterprise?.id ? `${enterprise.id}:${team.id}` : team.id,
      label: (team.name ?? team.id).slice(0, 200),
    },
    config: {
      teamId: team.id,
      ...(typeof response.bot_user_id === "string" ? { botUserId: response.bot_user_id } : {}),
    },
  }
}

export async function slackRefresh(
  refreshToken: string,
  options: { env?: NodeJS.ProcessEnv; fetch?: ProviderFetch } = {}
): Promise<TokenSet> {
  const { clientId, clientSecret } = requireConfig(options.env ?? process.env)
  const response = await slackCall(
    "oauth.v2.access",
    { client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken },
    { form: true, ...(options.fetch ? { fetch: options.fetch } : {}) }
  )
  const accessToken = typeof response.access_token === "string" ? response.access_token : ""

  if (!accessToken) throw new ProviderHttpError("invalid", "slack", 200, { providerCode: "invalid_response" })

  const rotated = typeof response.refresh_token === "string" ? response.refresh_token : undefined
  const expiry = expiresAt(response)

  return {
    accessToken,
    ...(rotated ? { refreshToken: rotated } : {}),
    ...(expiry ? { expiresAt: expiry } : {}),
    tokenType: "bot",
    scopes: scopesOf(response),
  }
}

export async function slackRevoke(tokens: TokenSet, options: { fetch?: ProviderFetch } = {}): Promise<void> {
  if (!tokens.accessToken) return

  await slackCall("auth.revoke", {}, { token: tokens.accessToken, form: true, ...(options.fetch ? { fetch: options.fetch } : {}) })
}
