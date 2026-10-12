import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const SESSION_COOKIE = "meetsum_session"
export const OAUTH_STATE_COOKIE = "meetsum_oauth_state"
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

/** Current session payload version. v1 (allowlist-era) cookies are rejected. */
export const SESSION_VERSION = 2

export type UserSession = {
  v: typeof SESSION_VERSION
  /** `users.id` of the signed-in user. */
  userId: string
  email: string
  name?: string
  picture?: string
  expiresAt: number
}

export type SessionIdentity = {
  userId: string
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
  return (value ?? "").split(",").map(normalizeEmail).filter(Boolean)
}

/**
 * Bootstrap allowlist (M2). `MEETSUM_ALLOWED_EMAILS` wins; otherwise the
 * configured Workspace subject. Listed emails always get a membership in
 * `ws_default` (see lib/workspaces/bootstrap.ts); sign-in itself is decided by
 * workspace membership or a pending invitation, not by this list.
 */
export function getAllowedEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  // Blank values count as unset, so `MEETSUM_ALLOWED_EMAILS=` in compose does
  // not shadow the workspace subject and lock everyone out.
  const firstSet = [
    env.MEETSUM_ALLOWED_EMAILS,
    env.GOOGLE_WORKSPACE_SUBJECT,
    env.GOOGLE_WORKSPACE_ADMIN_EMAIL,
  ].find((value) => value?.trim())

  return parseAllowedEmails(firstSet)
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
    now?: number
  }
): { name: typeof SESSION_COOKIE; value: string; maxAge: number } {
  const email = normalizeEmail(identity.email)

  if (!identity.userId || !email) {
    throw new Error("Session identity requires a user id and email")
  }

  const payload: UserSession = {
    v: SESSION_VERSION,
    userId: identity.userId,
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

/**
 * Verify a signed session cookie. Only v2 payloads (with a user id) are
 * accepted: membership is checked per request against the database, so the
 * cookie carries identity only.
 */
export function verifySessionCookie(
  value: string | undefined,
  options: {
    secret: string
    now?: number
  }
): UserSession | undefined {
  if (!value) return undefined

  const [encoded, signature] = value.split(".")

  if (!encoded || !signature) return undefined
  if (!safeEqual(sign(encoded, options.secret), signature)) return undefined

  try {
    const session = JSON.parse(base64UrlDecode(encoded)) as Partial<UserSession>

    if (session.v !== SESSION_VERSION) return undefined
    if (typeof session.userId !== "string" || !session.userId) return undefined
    if (typeof session.email !== "string" || !session.email) return undefined
    if (
      typeof session.expiresAt !== "number" ||
      session.expiresAt <= (options.now ?? Date.now())
    ) {
      return undefined
    }

    return session as UserSession
  } catch {
    return undefined
  }
}

export function getSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.MEETSUM_SESSION_SECRET

  if (!secret) {
    throw new Error("MEETSUM_SESSION_SECRET is required")
  }

  // The session-cookie HMAC key must never equal the webhook signing secret:
  // that secret is shared with external webhook consumers, so reuse would let
  // anyone who learns it forge session cookies.
  if (env.WEBHOOK_SIGNING_SECRET && secret === env.WEBHOOK_SIGNING_SECRET) {
    throw new Error(
      "MEETSUM_SESSION_SECRET must be different from WEBHOOK_SIGNING_SECRET"
    )
  }

  return secret
}

/** Read one cookie from a raw `Cookie` request header. */
export function readRequestCookie(
  request: Pick<Request, "headers">,
  name: string
): string | undefined {
  const header = request.headers.get("cookie")

  if (!header) return undefined

  for (const part of header.split(";")) {
    const index = part.indexOf("=")

    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue

    const raw = part.slice(index + 1).trim()

    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }

  return undefined
}
