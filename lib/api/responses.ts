import { NextResponse } from "next/server"

import { isAuthorizedApiRequest } from "@/lib/auth/api-keys"
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

  try {
    const session = await getCurrentSession()

    if (session) {
      return undefined
    }
  } catch {
    if (process.env.MEETSUM_REQUIRE_API_KEY !== "true") {
      return undefined
    }
  }

  return jsonError("Unauthorized", 401)
}
