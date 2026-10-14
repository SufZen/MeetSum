import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { ShareVerifyBusyError, verifySharePassword } from "@/lib/sharing/share-password"
import { withPublicRoute } from "@/lib/auth/authz"
import { getSessionSecret } from "@/lib/auth/session"
import { extractRateLimitKey, RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"
import { lookupPublicShare } from "@/lib/sharing/public-share"
import {
  SHARE_ACCESS_COOKIE,
  createShareAccessCookie,
  getShareAccessCookiePath,
  verifyShareAccessCookie,
} from "@/lib/sharing/share-access"
import { getShareMediaCookiePath } from "@/lib/sharing/share-media-access"
import { getShareVerifyThrottle } from "@/lib/meetings/store"
import { notifyShareAttempts } from "@/lib/notifications/notify"

/** Password attempts per IP per share token. */
const SHARE_VERIFY_RATE_LIMIT = RATE_LIMIT_PRESETS.shareVerify

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=")

    if (key === name) return rest.join("=")
  }

  return undefined
}

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
    const rateLimit = await rateLimitRequest(
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

    // Already verified (a valid access cookie): no password check at all.
    if (
      verifyShareAccessCookie(cookieValue(request, SHARE_ACCESS_COOKIE), {
        token,
        passwordHash: share.passwordHash,
        secret: getSessionSecret(),
      })
    ) {
      return form ? redirectToShare(token) : NextResponse.json({ valid: true, passwordRequired: true })
    }

    const password = await readPassword(request, form)
    const throttle = getShareVerifyThrottle()
    let isValid = false

    if (password) {
      // Per-token failure spacing across every IP (never a lock): after 10
      // failures attempts are spaced 2 s → 30 s; an early attempt gets 429.
      const decision = await throttle.begin(token)

      // The share vanished between the lookup and here: the same 404.
      if (!decision) return jsonError("Share link not found or expired", 404)
      if (!decision.allowed) {
        const retryAfter = String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)))

        return form
          ? redirectToShare(token, "rate_limited")
          : NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": retryAfter } })
      }

      try {
        isValid = await verifySharePassword(password, share.passwordHash, { key: token })
      } catch (error) {
        if (!(error instanceof ShareVerifyBusyError)) throw error

        // The verifier stayed saturated past the short queue timeout.
        return form
          ? redirectToShare(token, "rate_limited")
          : NextResponse.json({ error: "Service busy" }, { status: 503, headers: { "Retry-After": "5" } })
      }

      if (isValid) {
        await throttle.succeed(token)
      } else {
        const failed = await throttle.fail(token)

        if (failed?.notifyOwner && result.meeting.workspaceId) {
          // Once per streak: the owner learns the link is being guessed (no password data).
          await notifyShareAttempts({
            workspaceId: result.meeting.workspaceId,
            meetingId: result.meeting.id,
            ownerUserId: result.meeting.ownerUserId,
            shareId: share.id,
            failures: failed.failures,
          }).catch(() => undefined)
        }
      }
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
