import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { verifyApiKey } from "@/lib/auth/api-keys"
import { meetingRepository } from "@/lib/meetings/store"

/**
 * POST /api/share/:token/verify — Verify share link password.
 * Body: { password: string }
 *
 * Returns { valid: true } if the password matches, or 403 if not.
 * Returns { valid: true, passwordRequired: false } if no password is set.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const result = await meetingRepository.getShareByToken(token)

  if (!result) return jsonError("Share link not found or expired", 404)

  const { share } = result

  // No password set — always valid
  if (!share.passwordHash) {
    return NextResponse.json({ valid: true, passwordRequired: false })
  }

  const body = (await request.json().catch(() => ({}))) as {
    password?: unknown
  }

  const password = typeof body.password === "string" ? body.password : ""

  if (!password) {
    return NextResponse.json(
      { valid: false, passwordRequired: true },
      { status: 403 }
    )
  }

  const isValid = verifyApiKey(password, [share.passwordHash])

  if (!isValid) {
    return NextResponse.json(
      { valid: false, passwordRequired: true, error: "Incorrect password" },
      { status: 403 }
    )
  }

  return NextResponse.json({ valid: true, passwordRequired: true })
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
