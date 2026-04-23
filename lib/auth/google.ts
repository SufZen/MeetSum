import { OAuth2Client } from "google-auth-library"

import type { SessionIdentity } from "@/lib/auth/session"

export type GoogleOAuthConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function getGoogleOAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): GoogleOAuthConfig {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET
  const appUrl = env.NEXT_PUBLIC_APP_URL ?? env.MEETINGS_APP_URL
  const redirectUri =
    env.GOOGLE_OAUTH_REDIRECT_URI ??
    (appUrl ? `${appUrl}/api/auth/google/callback` : undefined)

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth is not configured")
  }

  return { clientId, clientSecret, redirectUri }
}

export async function exchangeGoogleCodeForIdentity(
  code: string,
  config: GoogleOAuthConfig
): Promise<SessionIdentity> {
  const client = new OAuth2Client(
    config.clientId,
    config.clientSecret,
    config.redirectUri
  )
  const { tokens } = await client.getToken(code)

  if (!tokens.id_token) {
    throw new Error("Google did not return an ID token")
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.clientId,
  })
  const payload = ticket.getPayload()

  if (!payload?.email || !payload.email_verified) {
    throw new Error("Google email is not verified")
  }

  return {
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  }
}
