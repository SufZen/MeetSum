import { readFileSync } from "node:fs"

import { google } from "googleapis"

import { getGoogleWorkspaceOAuthRefreshToken } from "@/lib/google/oauth-tokens"

export type WorkspaceAuthStrategy =
  | "user-oauth"
  | "keyless-iam-signjwt"
  | "json-key"
  | "key-file"
  | "missing"

export type WorkspaceAuthStatus = {
  subject: string
  serviceAccountEmail?: string
  strategy: WorkspaceAuthStrategy
  configured: boolean
  detail: string
}

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const IAM_SCOPE = "https://www.googleapis.com/auth/iam"

function getJsonKeyFile() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE

  if (!keyFile) return undefined

  try {
    return JSON.parse(readFileSync(keyFile, "utf8")) as {
      client_email?: string
      private_key?: string
    }
  } catch {
    return undefined
  }
}

export function getWorkspaceSubject() {
  return (
    process.env.GOOGLE_WORKSPACE_SUBJECT ??
    process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL ??
    "info@realization.co.il"
  )
}

export function getWorkspaceServiceAccountEmail() {
  return (
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ??
    process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT ??
    getJsonKeyFile()?.client_email
  )
}

function getPrivateKey() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n")
  }

  return getJsonKeyFile()?.private_key
}

function getStrategy(): WorkspaceAuthStrategy {
  if (process.env.GOOGLE_WORKSPACE_AUTH_STRATEGY === "user-oauth") {
    return "user-oauth"
  }

  const email = getWorkspaceServiceAccountEmail()

  if (!email) return "missing"
  if (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) return "json-key"
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && getPrivateKey()) {
    return "key-file"
  }

  return "keyless-iam-signjwt"
}

function getUserOAuthClientConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth client is not configured")
  }

  return { clientId, clientSecret }
}

export function getWorkspaceAuthStatus(
  subject = getWorkspaceSubject()
): WorkspaceAuthStatus {
  const serviceAccountEmail = getWorkspaceServiceAccountEmail()
  const strategy = getStrategy()
  const configured = strategy !== "missing"

  return {
    subject,
    serviceAccountEmail,
    strategy,
    configured,
    detail: !configured
      ? "Missing Google Workspace service-account email or OAuth strategy"
      : strategy === "user-oauth"
        ? "Using first-admin Google OAuth refresh token"
        : strategy === "keyless-iam-signjwt"
          ? "Using IAM Credentials signJwt with Application Default Credentials"
          : "Using service-account private-key credentials",
  }
}

function secondsSinceEpoch() {
  return Math.floor(Date.now() / 1000)
}

async function createKeylessDelegatedClient(
  subject: string,
  scopes: readonly string[]
) {
  const serviceAccountEmail = getWorkspaceServiceAccountEmail()

  if (!serviceAccountEmail) {
    throw new Error("Google Workspace service-account email is missing")
  }

  const sourceAuth = new google.auth.GoogleAuth({ scopes: [IAM_SCOPE] })
  const iam = google.iamcredentials({ version: "v1", auth: sourceAuth })
  const now = secondsSinceEpoch()
  const signResponse = await iam.projects.serviceAccounts.signJwt({
    name: `projects/-/serviceAccounts/${serviceAccountEmail}`,
    requestBody: {
      payload: JSON.stringify({
        iss: serviceAccountEmail,
        sub: subject,
        scope: scopes.join(" "),
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    },
  })
  const signedJwt = signResponse.data.signedJwt

  if (!signedJwt) {
    throw new Error("Google IAM signJwt returned no signed JWT")
  }

  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt,
    }),
  })
  const tokenBody = (await tokenResponse.json()) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }

  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new Error(
      tokenBody.error_description ??
        tokenBody.error ??
        "Unable to exchange signed Workspace JWT"
    )
  }

  const client = new google.auth.OAuth2()

  client.setCredentials({
    access_token: tokenBody.access_token,
    expiry_date: Date.now() + (tokenBody.expires_in ?? 3600) * 1000,
  })

  return client
}

function createPrivateKeyDelegatedClient(
  subject: string,
  scopes: readonly string[]
) {
  const email = getWorkspaceServiceAccountEmail()
  const key = getPrivateKey()

  if (!email || !key) {
    throw new Error(
      "Google Workspace service-account email or private key is missing"
    )
  }

  return new google.auth.JWT({
    email,
    key,
    scopes: [...scopes],
    subject,
  })
}

async function createUserOAuthWorkspaceClient(subject: string) {
  const { clientId, clientSecret } = getUserOAuthClientConfig()
  const refreshToken = await getGoogleWorkspaceOAuthRefreshToken(subject)
  const client = new google.auth.OAuth2(clientId, clientSecret)

  client.setCredentials({ refresh_token: refreshToken })

  return client
}

export async function createDelegatedGoogleClient(
  subject: string,
  scopes: readonly string[]
) {
  const strategy = getStrategy()

  if (strategy === "missing") {
    throw new Error("Google Workspace domain-wide delegation is not configured")
  }

  if (strategy === "keyless-iam-signjwt") {
    return createKeylessDelegatedClient(subject, scopes)
  }

  if (strategy === "user-oauth") {
    return createUserOAuthWorkspaceClient(subject)
  }

  return createPrivateKeyDelegatedClient(subject, scopes)
}
