import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Vexa webhook authentication (M7 B3).
 *
 * Primary: `X-Webhook-Signature: sha256=<hex HMAC_SHA256(secret, "<ts>." +
 * rawBody)>` with `X-Webhook-Timestamp` (Unix seconds) inside the tolerance
 * window. Legacy `Authorization: Bearer <secret>` is accepted only when
 * explicitly allowed. Every comparison is constant-time on equal-length
 * buffers and never throws on malformed input.
 */

export type VexaSignatureOptions = {
  /** Default 300 seconds. */
  toleranceSeconds?: number
  /** VEXA_WEBHOOK_ALLOW_BEARER. */
  allowBearer?: boolean
}

export type VexaSignatureResult =
  | { ok: true; method: "hmac" | "bearer" }
  | { ok: false; reason: "missing" | "stale" | "mismatch" }

type HeaderSource = Headers | Record<string, string | undefined>

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined

  const wanted = name.toLowerCase()

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value ?? undefined
  }

  return undefined
}

/** Constant-time string equality; unequal lengths compare a dummy and fail. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")

  if (left.length !== right.length) {
    // Keep the timing independent of where the inputs differ.
    timingSafeEqual(left, left)
    return false
  }

  return timingSafeEqual(left, right)
}

export function signVexaWebhook(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`
}

export function verifyVexaSignature(
  headers: HeaderSource,
  rawBody: string,
  secret: string,
  now: Date = new Date(),
  options: VexaSignatureOptions = {}
): VexaSignatureResult {
  if (!secret) return { ok: false, reason: "missing" }

  const signature = header(headers, "x-webhook-signature")?.trim()
  const timestamp = header(headers, "x-webhook-timestamp")?.trim()

  if (signature && timestamp) {
    if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "stale" }

    const tolerance = options.toleranceSeconds ?? 300
    const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp))

    if (skew > tolerance) return { ok: false, reason: "stale" }

    return constantTimeEqual(signature.toLowerCase(), signVexaWebhook(secret, timestamp, rawBody))
      ? { ok: true, method: "hmac" }
      : { ok: false, reason: "mismatch" }
  }

  if (options.allowBearer) {
    const authorization = header(headers, "authorization")?.trim()
    const match = authorization?.match(/^Bearer\s+(.+)$/i)

    if (match) {
      return constantTimeEqual(match[1].trim(), secret)
        ? { ok: true, method: "bearer" }
        : { ok: false, reason: "mismatch" }
    }
  }

  return { ok: false, reason: "missing" }
}
