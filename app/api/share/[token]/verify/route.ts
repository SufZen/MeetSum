import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { ShareVerifyBusyError, verifySharePassword } from "@/lib/sharing/share-password"
import { withPublicRoute } from "@/lib/auth/authz"
import { getSessionSecret } from "@/lib/auth/session"
import { extractRateLimitKey, rateLimitRequest } from "@/lib/rate-limit"
import { lookupPublicShare } from "@/lib/sharing/public-share"
import {
  createShareAccessCookie,
  getShareAccessCookiePath,
} from "@/lib/sharing/share-access"
import { getShareMediaCookiePath } from "@/lib/sharing/share-media-access"

/** Password attempts per IP per share token. */
const SHARE_VERIFY_RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 }

/**
 * Password attempts per share token across every IP (a botnet rotating IPs
 * still gets 30 guesses per 10 minutes for one link).
 */
const SHARE_VERIFY_TOKEN_RATE_LIMIT = { maxRequests: 30, windowMs: 10 * 60_000 }

function isFormSubmission(request: Request) {
  const contentType = request.headers.get("content-type") ?? ""

  return (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  )
}

async function readPassword(request: Request, form: boolean) {
  if (form) {
    const data = await request.formData().catch(() => undefined)
    const value = data?.get("password")

    return typeof value === "string" ? value : ""
  }

  const body = (await request.json().catch(() => ({}))) as {
    password?: unknown
  }

  return typeof body.password === "string" ? body.password : ""
}

function redirectToShare(token: string, error?: string) {
  const location = `${getShareAccessCookiePath(token)}${
    error ? `?error=${encodeURIComponent(error)}` : ""
  }`

  // Relative Location (valid per RFC 9110) so redirects stay correct behind
  // the reverse proxy; 303 makes the browser follow with GET after the POST.
  return new NextResponse(null, { status: 303, headers: { location } })
}

/**
 * POST /api/share/:token/verify — Verify a share link password.
 *
 * Accepts either an HTML form post (`password` field; responds with a 303
 * redirect back to the share page) or JSON `{ password }` (responds with
 * `{ valid }`). On success an httpOnly, short-lived, signed cookie scoped to
 * `/share/:token` is set, so the password never travels in the URL.
 */
export const POST = withPublicRoute<{ token: string }>(
  "Public share-link password check; the unguessable token is the credential.",
  async (request, { params }) => {
    const { token } = await params
    const form = isFormSubmission(request)
    const rateLimit = rateLimitRequest(
      request,
      SHARE_VERIFY_RATE_LIMIT,
      extractRateLimitKey(request, `share-verify:${token}`)
    )

    if (rateLimit.blocked) {
      return form ? redirectToShare(token, "rate_limited") : rateLimit.blocked
    }

    const result = await lookupPublicShare(token)

    if (!result) return jsonError("Share link not found or expired", 404)

    const { share } = result

    // No password set — always valid
    if (!share.passwordHash) {
      return form
        ? redirectToShare(token)
        : NextResponse.json({ valid: true, passwordRequired: false })
    }

    const tokenLimit = rateLimitRequest(request, SHARE_VERIFY_TOKEN_RATE_LIMIT, `share-verify-token:${token}`)

    if (tokenLimit.blocked) {
      return form ? redirectToShare(token, "rate_limited") : tokenLimit.blocked
    }

    const password = await readPassword(request, form)
    let isValid = false

    try {
      isValid = Boolean(password) && (await verifySharePassword(password, share.passwordHash))
    } catch (error) {
      if (!(error instanceof ShareVerifyBusyError)) throw error

      return form
        ? redirectToShare(token, "rate_limited")
        : NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": "5" } })
    }

    if (!isValid) {
      if (form) return redirectToShare(token, "invalid")

      return NextResponse.json(
        {
          valid: false,
          passwordRequired: true,
          ...(password ? { error: "Incorrect password" } : {}),
        },
        { status: 403 }
      )
    }

    const cookie = createShareAccessCookie({
      token,
      passwordHash: share.passwordHash,
      secret: getSessionSecret(),
    })
    const response = form
      ? redirectToShare(token)
      : NextResponse.json({ valid: true, passwordRequired: true })

    response.cookies.set(cookie.name, cookie.value, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: cookie.path,
      maxAge: cookie.maxAge,
    })
    // Same proof for the share's media routes (M4): the page cookie's path
    // is not sent to /api/share/<token>/media. Appended raw: ResponseCookies
    // keys by name and would replace the page cookie.
    response.headers.append(
      "set-cookie",
      [
        `${cookie.name}=${cookie.value}`,
        `Path=${getShareMediaCookiePath(token)}`,
        `Max-Age=${cookie.maxAge}`,
        "HttpOnly",
        "SameSite=Lax",
        ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
      ].join("; ")
    )

    return response
  }
)

/**
 * GET /api/share/:token/verify — Check if share requires a password.
 */
export const GET = withPublicRoute<{ token: string }>(
  "Public share-link metadata (password required?); the token is the credential.",
  async (_request, { params }) => {
    const { token } = await params
    const result = await lookupPublicShare(token)

    if (!result) return jsonError("Share link not found or expired", 404)

    return NextResponse.json({
      passwordRequired: Boolean(result.share.passwordHash),
      expiresAt: result.share.expiresAt ?? null,
    })
  }
)
