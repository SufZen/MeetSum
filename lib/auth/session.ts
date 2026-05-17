import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const SESSION_COOKIE = "meetsum_session"
export const OAUTH_STATE_COOKIE = "meetsum_oauth_state"
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

export type UserSession = {
  email: string
  name?: string
  picture?: string
  expiresAt: number
}

export type SessionIdentity = {
  email: string
  name?: string
  picture?: string
}

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url")
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8")
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url")
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function parseAllowedEmails(value?: string): string[] {
  return (value ?? "info@realization.co.il")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean)
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url")
}

export function createGoogleAuthorizationUrl(options: {
  clientId: string
  redirectUri: string
  state: string
  loginHint?: string
  scopes?: string[]
  prompt?: string
}): URL {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")

  url.searchParams.set("client_id", options.clientId)
  url.searchParams.set("redirect_uri", options.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set(
    "scope",
    [...new Set(options.scopes ?? ["openid", "email", "profile"])].join(" ")
  )
  url.searchParams.set("state", options.state)
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", options.prompt ?? "select_account")
  url.searchParams.set("include_granted_scopes", "true")

  if (options.loginHint) {
    url.searchParams.set("login_hint", options.loginHint)
  }

  return url
}

export function createSessionCookie(
  identity: SessionIdentity,
  options: {
    secret: string
    allowedEmails: string[]
    now?: number
  }
): { name: typeof SESSION_COOKIE; value: string; maxAge: number } {
  const email = normalizeEmail(identity.email)
  const allowed = options.allowedEmails.map(normalizeEmail)

  if (!allowed.includes(email)) {
    throw new Error("Email is not allowed")
  }

  const payload: UserSession = {
    email,
    name: identity.name,
    picture: identity.picture,
    expiresAt: (options.now ?? Date.now()) + SESSION_MAX_AGE_SECONDS * 1000,
  }
  const encoded = base64UrlEncode(JSON.stringify(payload))
  const signature = sign(encoded, options.secret)

  return {
    name: SESSION_COOKIE,
    value: `${encoded}.${signature}`,
    maxAge: SESSION_MAX_AGE_SECONDS,
  }
}

export function verifySessionCookie(
  value: string | undefined,
  options: {
    secret: string
    allowedEmails: string[]
    now?: number
  }
): UserSession | undefined {
  if (!value) return undefined

  const [encoded, signature] = value.split(".")

  if (!encoded || !signature) return undefined
  if (!safeEqual(sign(encoded, options.secret), signature)) return undefined

  try {
    const session = JSON.parse(base64UrlDecode(encoded)) as UserSession
    const allowed = options.allowedEmails.map(normalizeEmail)

    if (!allowed.includes(normalizeEmail(session.email))) return undefined
    if (session.expiresAt <= (options.now ?? Date.now())) return undefined

    return session
  } catch {
    return undefined
  }
}

export function getSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.MEETSUM_SESSION_SECRET ?? env.WEBHOOK_SIGNING_SECRET

  if (!secret) {
    throw new Error("MEETSUM_SESSION_SECRET is required")
  }

  return secret
}
