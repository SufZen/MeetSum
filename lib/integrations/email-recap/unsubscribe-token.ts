/**
 * Email-recap unsubscribe token (docs/parity/m8.md A10). Owner: Package A.
 *
 * v2 (M8 e2e fix #9): OPAQUE. `u2.` + base64url(iv | AES-256-GCM(json{v:1,
 * ws, e, iat}) | tag), keyed by HKDF(MEETSUM_SESSION_SECRET,
 * "meetsum:email-unsubscribe-enc"). The address is encrypted (GCM also
 * authenticates it), so a link, a proxy log or a forwarded email never
 * reveals it. No expiry; bound to one workspace and one address.
 *
 * v1 (`base64url(json) + "." + HMAC`) still verifies for links already sent.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"

import { getSessionSecret } from "@/lib/auth/session"

export type UnsubscribePayload = { v: 1; ws: string; e: string; iat: number }

const V2_PREFIX = "u2."

function key(env: NodeJS.ProcessEnv): Buffer {
  return Buffer.from(hkdfSync("sha256", getSessionSecret(env), Buffer.alloc(0), "meetsum:email-unsubscribe", 32))
}

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  return Buffer.from(hkdfSync("sha256", getSessionSecret(env), Buffer.alloc(0), "meetsum:email-unsubscribe-enc", 32))
}

function mac(body: string, env: NodeJS.ProcessEnv): string {
  return createHmac("sha256", key(env)).update(body).digest("base64url")
}

function validPayload(payload: unknown): payload is UnsubscribePayload {
  const value = payload as UnsubscribePayload | undefined

  return value?.v === 1 && typeof value.ws === "string" && typeof value.e === "string" && value.e.includes("@")
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
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv)
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()])

  return `${V2_PREFIX}${Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url")}`
}

function verifyV2(token: string, env: NodeJS.ProcessEnv): UnsubscribePayload | undefined {
  try {
    const raw = Buffer.from(token.slice(V2_PREFIX.length), "base64url")

    if (raw.length < 12 + 16 + 2) return undefined

    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(env), raw.subarray(0, 12))

    decipher.setAuthTag(raw.subarray(raw.length - 16))

    const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8")
    const payload = JSON.parse(plain) as unknown

    return validPayload(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

/** The payload, or undefined for any malformed or tampered token. */
export function verifyUnsubscribeToken(token: string | null | undefined, env: NodeJS.ProcessEnv = process.env): UnsubscribePayload | undefined {
  if (!token || token.length > 2048) return undefined
  if (token.startsWith(V2_PREFIX)) return verifyV2(token, env)

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
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown

    return validPayload(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

/** Absolute `${APP}/api/email/unsubscribe?t=…` (List-Unsubscribe needs an absolute URL). */
export function unsubscribeUrl(token: string, env: NodeJS.ProcessEnv = process.env, locale?: "he" | "en"): string {
  const origin = (env.NEXT_PUBLIC_APP_URL?.trim() || env.MEETSUM_OAUTH_REDIRECT_BASE?.trim() || "http://localhost:3000").replace(/\/+$/, "")

  return `${origin}/api/email/unsubscribe?t=${encodeURIComponent(token)}${locale ? `&l=${locale}` : ""}`
}

/** Locale hint of an unsubscribe link (unsigned; only picks the page language). */
export function unsubscribeLocale(value: string | null | undefined): "he" | "en" {
  return value === "he" ? "he" : "en"
}
