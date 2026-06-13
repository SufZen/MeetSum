import { NextResponse } from "next/server"

import {
  extractBearerToken,
  isAuthorizedApiRequest,
  verifyDatabaseApiKey,
} from "@/lib/auth/api-keys"
import { getCurrentSession } from "@/lib/auth/server"

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

export function requireApiKey(request: Request) {
  if (process.env.MEETSUM_REQUIRE_API_KEY !== "true") {
    return undefined
  }

  if (!isAuthorizedApiRequest(request)) {
    return jsonError("Unauthorized", 401)
  }

  return undefined
}

export async function requireAppAccess(request: Request) {
  if (isAuthorizedApiRequest(request)) {
    return undefined
  }

  // Admin-created (database-backed) API keys, so keys minted in the UI work.
  const bearer = extractBearerToken(request.headers)

  if (bearer && (await verifyDatabaseApiKey(bearer))) {
    return undefined
  }

  try {
    const session = await getCurrentSession()

    if (session) {
      return undefined
    }
  } catch (error) {
    // Fail closed: a broken/throwing session must never grant access.
    console.error("[auth] session validation failed", error)
  }

  return jsonError("Unauthorized", 401)
}
