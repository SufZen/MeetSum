import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { verifyApiKey } from "@/lib/auth/api-keys"
import { getSessionSecret } from "@/lib/auth/session"
import { meetingRepository } from "@/lib/meetings/store"
import { extractRateLimitKey, rateLimitRequest } from "@/lib/rate-limit"
import {
  createShareAccessCookie,
  getShareAccessCookiePath,
} from "@/lib/sharing/share-access"

/** Password attempts per IP per share token. */
const SHARE_VERIFY_RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 }

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
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
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

  const result = await meetingRepository.getShareByToken(token)

  if (!result) return jsonError("Share link not found or expired", 404)

  const { share } = result

  // No password set — always valid
  if (!share.passwordHash) {
    return form
      ? redirectToShare(token)
      : NextResponse.json({ valid: true, passwordRequired: false })
  }

  const password = await readPassword(request, form)
  const isValid = Boolean(password) && verifyApiKey(password, [share.passwordHash])

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

  return response
}

/**
 * GET /api/share/:token/verify — Check if share requires a password.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const result = await meetingRepository.getShareByToken(token)

  if (!result) return jsonError("Share link not found or expired", 404)

  return NextResponse.json({
    passwordRequired: Boolean(result.share.passwordHash),
    expiresAt: result.share.expiresAt ?? null,
  })
}
