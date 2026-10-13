/**
 * Signed email-recap unsubscribe token (docs/parity/m8.md A10). Owner:
 * Package A. `base64url(json{v:1, ws, e, iat}) + "." + HMAC-SHA256`, keyed
 * by HKDF(MEETSUM_SESSION_SECRET, "meetsum:email-unsubscribe"). No expiry;
 * verified timing-safe. Bound to one workspace and one address.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto"

import { getSessionSecret } from "@/lib/auth/session"

export type UnsubscribePayload = { v: 1; ws: string; e: string; iat: number }

function key(env: NodeJS.ProcessEnv): Buffer {
  return Buffer.from(hkdfSync("sha256", getSessionSecret(env), Buffer.alloc(0), "meetsum:email-unsubscribe", 32))
}

function mac(body: string, env: NodeJS.ProcessEnv): string {
  return createHmac("sha256", key(env)).update(body).digest("base64url")
}

export function signUnsubscribeToken(
  input: { workspaceId: string; email: string; now?: number },
  env: NodeJS.ProcessEnv = process.env
): string {
  const payload: UnsubscribePayload = {
    v: 1,
    ws: input.workspaceId,
    e: input.email.trim().toLowerCase(),
    iat: Math.floor((input.now ?? Date.now()) / 1000),
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")

  return `${body}.${mac(body, env)}`
}

/** The payload, or undefined for any malformed or tampered token. */
export function verifyUnsubscribeToken(token: string | null | undefined, env: NodeJS.ProcessEnv = process.env): UnsubscribePayload | undefined {
  if (!token || token.length > 2048) return undefined

  const [body, signature, extra] = token.split(".")

  if (!body || !signature || extra !== undefined) return undefined

  let expected: Buffer

  try {
    expected = Buffer.from(mac(body, env))
  } catch {
    return undefined
  }

  const actual = Buffer.from(signature)

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UnsubscribePayload

    if (payload?.v !== 1 || typeof payload.ws !== "string" || typeof payload.e !== "string" || !payload.e.includes("@")) return undefined
    return payload
  } catch {
    return undefined
  }
}

/** Absolute `${APP}/api/email/unsubscribe?t=…` (List-Unsubscribe needs an absolute URL). */
export function unsubscribeUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const origin = (env.NEXT_PUBLIC_APP_URL?.trim() || env.MEETSUM_OAUTH_REDIRECT_BASE?.trim() || "http://localhost:3000").replace(/\/+$/, "")

  return `${origin}/api/email/unsubscribe?t=${encodeURIComponent(token)}`
}
